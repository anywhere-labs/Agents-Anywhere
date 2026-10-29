from __future__ import annotations

from pathlib import Path

from jsonschema import Draft202012Validator

from connector.runtime_protocol import (
    RuntimeConfig,
    RuntimeConfigSchema,
    RuntimeInvalidRequestError,
    RuntimeProvider,
    RuntimeTypeDescriptor,
    RuntimeUnavailableError,
)

from .domain.definitions import AgentProfile, LaunchDefinition


class AcpProvider(RuntimeProvider):
    implementation_type = "acp-stdio"
    instance_policy = "multiple"

    def __init__(self, profile: AgentProfile, *, runtime_type=None, preparation_driver=None,
                 configure_launch=None, config_properties=None, config_defaults=None):
        self.profile = profile
        self._runtime_type = runtime_type or profile.id
        self.preparation_driver = preparation_driver
        self.configure_launch = configure_launch or (lambda config, host, root: ())
        self.config_properties = config_properties or {}
        self.config_defaults = config_defaults or {}
        self._component_services = {}

    @property
    def runtime_type(self) -> str:
        return self._runtime_type

    @property
    def display_name(self) -> str:
        return self.profile.title

    def _components(self, host):
        import hashlib

        from .application.components import ComponentService
        from .infrastructure.artifacts import Artifacts
        from .infrastructure.persistence import Store
        from .infrastructure.releases import TRUSTED_RELEASE_KEYS, ReleaseFeed

        key = f"{host.session_namespace}:{host.runtime_id}"
        if key not in self._component_services:
            root = (
                host.runtime_kv.path.parent
                / "acp"
                / hashlib.sha256(key.encode()).hexdigest()
            )
            store = Store(root / "coordination.sqlite")
            artifacts = Artifacts(root / "releases", TRUSTED_RELEASE_KEYS)
            self._component_services[key] = ComponentService(
                store, artifacts, ReleaseFeed(artifacts), profile_ids={self.profile.id}
            )
        return self._component_services[key]

    async def manage_components(self, host, values):
        return await self._components(host).execute({**values, "profileId": values.get("profileId") or self.profile.id})

    async def get_config_schema(self):
        return RuntimeConfigSchema(
            runtime=self.runtime_type,
            revision=1,
            schema={
                "type": "object",
                "additionalProperties": False,
                "properties": {
                    **self.config_properties,
                    "componentReleaseId": {
                        "type": "string",
                        "pattern": "^[0-9a-f]{64}$",
                    },
                    "maxWorkers": {"type": "integer", "minimum": 1, "maximum": 32},
                    "maxConcurrentRuns": {
                        "type": "integer",
                        "minimum": 1,
                        "maximum": 16,
                    },
                    "maxRunMs": {
                        "type": "integer",
                        "minimum": 10000,
                        "maximum": 3600000,
                    },
                },
            },
            defaults={
                **self.config_defaults,
                "maxWorkers": 8,
                "maxConcurrentRuns": 4,
                "maxRunMs": 600000,
            },
            metadata={"releaseGate": self.profile.unavailable_reason},
        )

    async def discover(self):
        from .domain.capabilities import verified_release

        available = False
        installation_error = None
        for service in self._component_services.values():
            for installed in service.store.values("installation"):
                if verified_release(self.profile, installed["manifest"]):
                    try:
                        service.artifacts.verify_installed(installed)
                    except Exception as error:  # noqa: BLE001 -- damaged installation remains unavailable
                        installation_error = getattr(error, "code", "component_invalid")
                    else:
                        available = True
        return RuntimeTypeDescriptor(
            runtime_type=self.runtime_type,
            display_name=self.profile.title,
            available=available,
            reason=None
            if available
            else f"{self.profile.title} 运行组件尚未就绪。",
            implementation_type=self.implementation_type,
            instance_policy="multiple",
            config_schema=await self.get_config_schema(),
            capabilities={"workspacePreparation": True, "asyncCreation": True}
            if available
            else {},
            metadata={
                "releaseGate": self.profile.unavailable_reason,
                "installationError": installation_error,
                "agentProfiles": [
                    {"id": self.profile.id, "displayName": self.profile.title, "available": available}
                ],
            },
        )

    async def validate_config(self, values):
        values = dict(values)
        legacy_profile = values.pop("agentProfileId", self.profile.id)
        if legacy_profile != self.profile.id:
            raise RuntimeInvalidRequestError("Agent 类型与实例不匹配。")
        schema = await self.get_config_schema()
        errors = list(Draft202012Validator(schema.schema).iter_errors(dict(values)))
        if errors:
            raise RuntimeInvalidRequestError(errors[0].message)
        normalized = {**schema.defaults, **values}
        if normalized["maxConcurrentRuns"] > normalized["maxWorkers"]:
            raise RuntimeInvalidRequestError("并发运行数不能超过执行进程数。")
        return RuntimeConfig(
            runtime=self.runtime_type,
            revision=1,
            values=normalized,
            schema=schema.schema,
            metadata=schema.metadata,
        )

    async def create_runtime(self, config, host):
        from .domain.capabilities import verified_release
        from .runtime import AcpRuntime

        components = self._components(host)
        selected = config.values.get("componentReleaseId")
        if selected is None:
            selected = (
                components.store.get("active_component", self.profile.id) or {}
            ).get("releaseId")
        installed = components.store.get("installation", selected) if selected else None
        if not installed:
            raise RuntimeUnavailableError(f"{self.profile.title} 尚未安装通过验收的运行组件。")
        components.artifacts.verify_installed(installed)
        manifest = installed["manifest"]
        if not verified_release(self.profile, manifest):
            raise RuntimeUnavailableError(
                f"{self.profile.title} 组件缺少所需的签名验收记录。"
            )
        root = Path(installed["path"])
        launcher = manifest["launcher"]
        arguments = tuple(
            arg.replace("${COMPONENT_ROOT}", str(root)) for arg in launcher["arguments"]
        )
        launch = LaunchDefinition(
            str(root / launcher["executable"]),
            arguments + tuple(self.configure_launch(config, host, components.artifacts.root.parent)),
            selected,
        )
        return AcpRuntime(
            config, host, self.profile, launch, preparation_driver=self.preparation_driver
        )
