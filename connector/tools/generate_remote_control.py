"""Export the versioned Server -> Connector MeshCall control contract."""

from pathlib import Path

from meshcall import get_service_contract, write_contract

from connector.server.mesh_services import DOMAIN_SERVICE_TYPES

EXPECTED_METHOD_COUNTS = {
    "RuntimeControl": 10,
    "Sessions": 13,
    "Workspaces": 1,
    "Files": 5,
    "Shell": 3,
    "Terminals": 10,
}

contracts = []
for domain, service_type in DOMAIN_SERVICE_TYPES.items():
    contract = get_service_contract(service_type)
    expected = EXPECTED_METHOD_COUNTS[domain]
    if len(contract.methods) != expected:
        raise RuntimeError(
            f"{domain} contract has {len(contract.methods)} methods; expected {expected}"
        )
    contracts.append(contract)

root = Path(__file__).resolve().parents[2]
write_contract(
    contracts,
    root / "contracts/connector-control/1.0/service.json",
)
