from __future__ import annotations

import asyncio
import json
from types import SimpleNamespace

import pytest
from redis.exceptions import RedisError

from agent_server.infra import connector_rpc_frames as framing
from agent_server.infra.connector_rpc_frames import ConnectorRpcFrames
from agent_server.infra.redis_coordinator import RedisCoordinator


class FrameBus:
    def __init__(self):
        self.peers = {}
        self.records = []
        self.transform = lambda payload: payload

    async def publish(self, channel, encoded):
        payload = json.loads(encoded)
        self.records.append(payload)
        peer = self.peers.get(channel.rsplit(':', 1)[-1])
        if peer is None:
            return 0
        selected = self.transform(payload)
        if selected is not None and not peer.accept(selected):
            peer._deliver(selected)
        await asyncio.sleep(0)
        return 1


async def settle(predicate):
    async with asyncio.timeout(2):
        while not predicate():
            await asyncio.sleep(0)


def setup(monkeypatch):
    monkeypatch.setattr(framing, 'CHUNK_BYTES', 128)
    monkeypatch.setattr(framing, 'CHUNK_WAIT_SECONDS', .03)
    bus = FrameBus()
    received = {'a': [], 'b': []}
    coordinator = RedisCoordinator(client=SimpleNamespace(publish=bus.publish))
    for name, messages in received.items():
        bus.peers[name] = ConnectorRpcFrames(coordinator, name, messages.append)
    return bus, received


def test_framing_preserves_encoded_content_and_receiver_pulls_one_chunk_at_a_time(monkeypatch):
    async def exercise():
        bus, received = setup(monkeypatch)
        payload = {'type': 'request', 'requestId': 'route', 'params': {'content': '中文\\\"\n' * 500}}
        try:
            assert await bus.peers['a'].publish('b', payload) == 1
            await settle(lambda: bool(received['b']))
            assert received['b'] == [payload]
            transfer = [row for row in bus.records if row['type'] in {'relay.pull', 'relay.data'}]
            assert [row['type'] for row in transfer] == ['relay.pull', 'relay.data'] * (len(transfer) // 2)
            assert max(len(json.dumps(row).encode()) for row in transfer) < 1024
        finally:
            await asyncio.gather(*(peer.close() for peer in bus.peers.values()))
    asyncio.run(exercise())


@pytest.mark.parametrize('fault', ['missing', 'corrupt'])
def test_incomplete_transfer_never_delivers_business_and_the_next_transfer_works(monkeypatch, fault):
    async def exercise():
        bus, received = setup(monkeypatch)
        def damaged(payload):
            if payload['type'] == 'relay.data' and payload['index'] == 1:
                return None if fault == 'missing' else {**payload, 'data': 'invalid-base64!'}
            return payload
        bus.transform = damaged
        try:
            with pytest.raises(RedisError):
                await bus.peers['a'].publish('b', {'type': 'request', 'text': 'x' * 1000}, timeout=1)
            assert not received['b']
            bus.transform = lambda payload: payload
            assert await bus.peers['a'].publish('b', {'type': 'response', 'text': 'y' * 1000}) == 1
            await settle(lambda: bool(received['b']))
            assert received['b'] == [{'type': 'response', 'text': 'y' * 1000}]
            assert not bus.peers['a']._outbound
        finally:
            await asyncio.gather(*(peer.close() for peer in bus.peers.values()))
    asyncio.run(exercise())


def test_small_critical_packet_bypasses_a_stalled_large_transfer(monkeypatch):
    async def exercise():
        bus, received = setup(monkeypatch)
        held = []
        def hold(payload):
            if payload['type'] == 'relay.data' and payload['index'] == 0:
                held.append(payload)
                return None
            return payload
        bus.transform = hold
        publishing = asyncio.create_task(bus.peers['a'].publish('b', {'type': 'request', 'text': 'x' * 1000}))
        try:
            await settle(lambda: bool(held))
            critical = {'type': 'request', 'method': 'interaction.respond'}
            assert await bus.peers['a'].publish('b', critical) == 1
            assert received['b'] == [critical] and not publishing.done()
            bus.peers['b'].accept(held[0])
            assert await publishing == 1
            await settle(lambda: len(received['b']) == 2)
        finally:
            publishing.cancel()
            await asyncio.gather(publishing, return_exceptions=True)
            await asyncio.gather(*(peer.close() for peer in bus.peers.values()))
    asyncio.run(exercise())


def test_duplicate_open_and_pull_do_not_replay_a_completed_envelope(monkeypatch):
    async def exercise():
        bus, received = setup(monkeypatch)
        try:
            assert await bus.peers['a'].publish('b', {'type': 'request', 'text': 'x' * 1000}) == 1
            await settle(lambda: bool(received['b']))
            opened = next(row for row in bus.records if row['type'] == 'relay.open')
            pulls = [row for row in bus.records if row['type'] == 'relay.pull']
            bus.peers['b'].accept(opened)
            for pull in pulls:
                bus.peers['a'].accept(pull)
            await asyncio.wait_for(bus.peers['b']._queue.join(), 1)
            assert len(received['b']) == 1
        finally:
            await asyncio.gather(*(peer.close() for peer in bus.peers.values()))
    asyncio.run(exercise())


def test_subscription_reset_aborts_partial_state_without_replaying_it(monkeypatch):
    async def exercise():
        bus, received = setup(monkeypatch)
        bus.transform = lambda payload: None if payload['type'] == 'relay.data' else payload
        publisher = asyncio.create_task(bus.peers['a'].publish('b', {'type': 'request', 'text': 'x' * 1000}))
        try:
            await settle(lambda: bool(bus.peers['b']._waiting))
            await bus.peers['a'].reset()
            await bus.peers['b'].reset()
            with pytest.raises(RedisError):
                await publisher
            assert not received['b'] and not bus.peers['b']._incoming
            bus.transform = lambda payload: payload
            assert await bus.peers['a'].publish('b', {'type': 'request', 'text': 'new' * 1000}) == 1
            await settle(lambda: bool(received['b']))
            assert len(received['b']) == 1
        finally:
            publisher.cancel()
            await asyncio.gather(publisher, return_exceptions=True)
            await asyncio.gather(*(peer.close() for peer in bus.peers.values()))
    asyncio.run(exercise())


def test_publish_connection_loss_does_not_retry_a_logical_packet():
    from redis.asyncio import Redis
    from redis.asyncio.retry import Retry
    from redis.backoff import NoBackoff
    from redis.exceptions import ConnectionError as RedisConnectionError
    async def exercise():
        class Publisher(Redis):
            def __init__(self):
                super().__init__()
                self.connection = SimpleNamespace(retry=Retry(NoBackoff(), 3))
                self.attempts = 0
            def client(self): return self
            async def __aenter__(self): return self
            async def __aexit__(self, *args): pass
            async def publish(self, *args):
                async def send():
                    self.attempts += 1
                    raise RedisConnectionError('response lost after send')
                async def disconnected(_error): pass
                return await self.connection.retry.call_with_retry(send, disconnected)
        publisher = Publisher()
        original_policy = publisher.connection.retry
        frames = ConnectorRpcFrames(RedisCoordinator(client=publisher), 'a', lambda _message: None)
        try:
            with pytest.raises(RedisConnectionError):
                await frames.publish('b', {'type': 'request', 'method': 'session.send_message'})
            assert publisher.attempts == 1
            assert publisher.connection.retry is original_policy
        finally:
            await frames.close()
            publisher.connection = None
            await publisher.connection_pool.disconnect()
    asyncio.run(exercise())


def test_zero_subscribers_after_a_fragment_is_not_proof_of_non_dispatch(monkeypatch):
    async def exercise():
        bus, received = setup(monkeypatch)
        client = bus.peers['a']._coordinator.client
        original = client.publish
        async def disconnect(channel, encoded):
            payload = json.loads(encoded)
            if payload['type'] == 'relay.data' and payload['index'] == 1:
                return 0
            return await original(channel, encoded)
        client.publish = disconnect
        try:
            with pytest.raises(RedisError):
                await bus.peers['a'].publish('b', {'type': 'request', 'text': 'x' * 1000})
            assert not received['b']
        finally:
            await asyncio.gather(*(peer.close() for peer in bus.peers.values()))
    asyncio.run(exercise())
