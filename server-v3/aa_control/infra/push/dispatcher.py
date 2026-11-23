from __future__ import annotations

from loguru import logger

from aa_control.core.config import PushConfig
from aa_control.infra.push.apns import ApnsSender
from aa_control.infra.push.base import LoggingPushProvider, PushDeliveryEnvelope, PushProvider
from aa_control.infra.push.fcm import FcmSender


class PlatformPushProvider:
    """Routes deliveries by client platform: ``ios`` → APNs, ``android`` → FCM.

    Platforms without a configured sender (``desktop``, ``web``, or iOS/Android when
    credentials are absent) keep the pre-sender behaviour: the notice is logged and dropped.
    """

    def __init__(
        self,
        *,
        apns: ApnsSender | None = None,
        fcm: FcmSender | None = None,
        fallback: PushProvider | None = None,
    ) -> None:
        self._apns = apns
        self._fcm = fcm
        self._fallback: PushProvider = fallback or LoggingPushProvider()

    @property
    def apns_enabled(self) -> bool:
        return self._apns is not None

    @property
    def fcm_enabled(self) -> bool:
        return self._fcm is not None

    def status(self) -> dict[str, str]:
        return {
            "apns": "configured" if self._apns is not None else "disabled",
            "fcm": "configured" if self._fcm is not None else "disabled",
        }

    async def send(self, envelope: PushDeliveryEnvelope) -> None:
        if envelope.platform == "ios" and self._apns is not None:
            await self._apns.send(envelope)
            return
        if envelope.platform == "android" and self._fcm is not None:
            await self._fcm.send(envelope)
            return
        await self._fallback.send(envelope)

    async def close(self) -> None:
        if self._apns is not None:
            await self._apns.close()
        if self._fcm is not None:
            await self._fcm.close()


def build_push_provider(config: PushConfig) -> PlatformPushProvider:
    """Create platform senders from configuration and log which ones are active."""
    apns = ApnsSender(config.apns) if config.apns is not None else None
    fcm = FcmSender(config.fcm) if config.fcm is not None else None
    if apns is None:
        logger.info("push: APNs not configured (AA_CONTROL_APNS_*); iOS notices are logged only")
    else:
        assert config.apns is not None
        logger.info("push: APNs sender enabled environment={}", config.apns.environment)
    if fcm is None:
        logger.info("push: FCM not configured (AA_CONTROL_FCM_*); Android notices are logged only")
    else:
        assert config.fcm is not None
        logger.info("push: FCM sender enabled project={}", config.fcm.project_id)
    return PlatformPushProvider(apns=apns, fcm=fcm)
