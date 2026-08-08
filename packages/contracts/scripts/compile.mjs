import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import solc from 'solc';

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const contractsRoot = join(packageRoot, 'contracts');
const workspaceRoot = resolve(packageRoot, '../..');
const artifactsRoot = join(packageRoot, 'artifacts-solc');
const EIP170_RUNTIME_LIMIT = 24_576;
const EIP3860_INITCODE_LIMIT = 49_152;

function collectSources(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const absolute = join(directory, entry.name);
    if (entry.isDirectory()) return collectSources(absolute);
    if (!entry.name.endsWith('.sol')) return [];
    const sourceName = relative(contractsRoot, absolute).replaceAll('\\', '/');
    return [[sourceName, { content: readFileSync(absolute, 'utf8') }]];
  });
}

function resolveImport(importPath) {
  const candidates = [
    join(contractsRoot, importPath),
    join(packageRoot, 'node_modules', importPath),
    join(workspaceRoot, 'node_modules', importPath),
  ];
  const match = candidates.find((candidate) => existsSync(candidate));
  return match ? { contents: readFileSync(match, 'utf8') } : { error: `Import not found: ${importPath}` };
}

const input = {
  language: 'Solidity',
  sources: Object.fromEntries(collectSources(contractsRoot)),
  settings: {
    optimizer: { enabled: true, runs: 500 },
    // V2 deliberately uses rich typed state and atomic settlement paths. The production
    // Hardhat profile already compiles through IR; keep local artifacts byte-for-byte aligned.
    viaIR: true,
    outputSelection: {
      '*': {
        '*': ['abi', 'evm.bytecode.object', 'evm.deployedBytecode.object'],
      },
    },
  },
};

const output = JSON.parse(solc.compile(JSON.stringify(input), { import: resolveImport }));
const diagnostics = output.errors ?? [];
for (const diagnostic of diagnostics) {
  const stream = diagnostic.severity === 'error' ? process.stderr : process.stdout;
  stream.write(`${diagnostic.formattedMessage}\n`);
}
if (diagnostics.some((diagnostic) => diagnostic.severity === 'error')) process.exit(1);

rmSync(artifactsRoot, { recursive: true, force: true });
mkdirSync(artifactsRoot, { recursive: true });

for (const [sourceName, contracts] of Object.entries(output.contracts)) {
  for (const [contractName, artifact] of Object.entries(contracts)) {
    if (!artifact.evm.bytecode.object) continue;
    if (sourceName.startsWith('v2/')) {
      const runtimeBytes = artifact.evm.deployedBytecode.object.length / 2;
      const initcodeBytes = artifact.evm.bytecode.object.length / 2;
      if (runtimeBytes > EIP170_RUNTIME_LIMIT) {
        throw new Error(`${contractName} runtime is ${runtimeBytes} bytes; EIP-170 limit is ${EIP170_RUNTIME_LIMIT}.`);
      }
      if (initcodeBytes > EIP3860_INITCODE_LIMIT) {
        throw new Error(`${contractName} initcode is ${initcodeBytes} bytes; EIP-3860 limit is ${EIP3860_INITCODE_LIMIT}.`);
      }
    }
    const destination = join(artifactsRoot, `${contractName}.json`);
    writeFileSync(destination, JSON.stringify({
      contractName,
      sourceName,
      abi: artifact.abi,
      bytecode: `0x${artifact.evm.bytecode.object}`,
      deployedBytecode: `0x${artifact.evm.deployedBytecode.object}`,
    }, null, 2));
  }
}

console.log(`Compiled ${Object.keys(output.contracts).length} Solidity source units with solc ${solc.version()}.`);
