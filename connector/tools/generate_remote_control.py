"""Export the versioned Server -> Connector MeshCall control contract."""

import argparse
import ast
from pathlib import Path

from meshcall import get_service_contract, write_contract
from meshcall.contract_io import render_contract

from connector.server.local_rpc import LocalRpcHandler
from connector.server.mesh_services import DOMAIN_SERVICE_TYPES
from connector.server.runtime_rpc import RuntimeRpcHandler

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
target = root / "contracts/connector-control/1.0/service.json"
parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument("--check", action="store_true", help="Check generation and dispatch coverage without writing")
args = parser.parse_args()
if args.check:
    tree = ast.parse((root / "server/agent_server/infra/connector_mesh_contract.py").read_text())
    mapping = next(ast.literal_eval(node.value) for node in tree.body
                   if isinstance(node, ast.AnnAssign) and isinstance(node.target, ast.Name)
                   and node.target.id == "CONTROL_METHODS")
    implemented = RuntimeRpcHandler.METHODS | LocalRpcHandler.METHODS
    if set(mapping) != implemented | {"workspace.refresh"}:
        raise SystemExit("Remote control routing and dispatcher coverage differ")
    service_methods = {(domain, method.name) for domain, contract in zip(DOMAIN_SERVICE_TYPES, contracts, strict=True)
                       for method in contract.methods}
    if set(mapping.values()) != service_methods:
        raise SystemExit("Remote control routing and service methods differ")
    if target.read_text(encoding="utf-8") != render_contract(contracts):
        raise SystemExit("Remote control contract is stale; run tools/generate_remote_control.py")
    print(f"Remote control contract matches: {len(implemented)} implemented, 1 reserved")
else:
    write_contract(contracts, target)
