// src/main.ts
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
var CLI_PACKAGE = "bohr@latest";
var CLI_PACKAGE_ENV = "BOHR_CLI_PACKAGE";
function installation(prefix, env = process.env, options = {}) {
  const execPath = options.execPath ?? process.execPath;
  const exists = options.exists ?? existsSync;
  const nodeDir = dirname(execPath);
  const npmCli = [
    join(nodeDir, "..", "lib", "node_modules", "npm", "bin", "npm-cli.js"),
    join(nodeDir, "node_modules", "npm", "bin", "npm-cli.js")
  ].find((path) => exists(path));
  const spec = env[CLI_PACKAGE_ENV]?.trim() || CLI_PACKAGE;
  const npmArgs = ["install", "--prefix", prefix, "--no-save", "--no-audit", "--no-fund", "--loglevel=error", spec];
  if (npmCli !== void 0) return { command: execPath, args: [npmCli, ...npmArgs], env, shell: false };
  return { command: "npm", args: npmArgs, env, shell: (options.platform ?? process.platform) === "win32" };
}
function cliEntry(prefix, read = (path) => readFileSync(path, "utf8")) {
  const packageDir = join(prefix, "node_modules", "bohr");
  const manifest = JSON.parse(read(join(packageDir, "package.json")));
  const bin = typeof manifest.bin === "string" ? manifest.bin : manifest.bin?.bohr;
  if (!bin) throw new Error('The installed bohr package has no "bohr" executable.');
  return join(packageDir, bin);
}
function invocation(entry, env = process.env, options = {}) {
  const pathKey = Object.keys(env).find((key) => key.toUpperCase() === "PATH") ?? "PATH";
  return {
    command: options.execPath ?? process.execPath,
    args: [entry, "action"],
    env: { ...env, BOHR_ACTION_CWD: options.cwd ?? process.cwd(), BOHR_ACTION_PATH: env[pathKey] ?? "" },
    shell: false
  };
}
function run(start, output = "inherit") {
  return new Promise((resolve) => {
    const child = spawn(start.command, start.args, {
      env: start.env,
      shell: start.shell,
      // npm's own output goes to the log, never to what the CLI reads
      stdio: output === "inherit" ? "inherit" : ["ignore", process.stderr, process.stderr]
    });
    child.once("error", (error) => {
      process.stdout.write(
        `::error::Could not start ${start.command} (${error.message}). Set up Node.js (actions/setup-node) before this action.
`
      );
      resolve(1);
    });
    child.once("close", (code) => resolve(code ?? 1));
  });
}
async function main(env = process.env) {
  const prefix = mkdtempSync(join(env.RUNNER_TEMP || tmpdir(), "bohr-cli-"));
  const installed = await run(installation(prefix, env), "stderr");
  if (installed !== 0) {
    process.stdout.write(
      `::error::Could not install the bohr CLI (${env[CLI_PACKAGE_ENV]?.trim() || CLI_PACKAGE}) from npm.
`
    );
    return installed;
  }
  return run(invocation(cliEntry(prefix), env));
}
if (!process.env.VITEST) {
  void main().then((code) => {
    process.exitCode = code;
  });
}
export {
  CLI_PACKAGE,
  CLI_PACKAGE_ENV,
  cliEntry,
  installation,
  invocation,
  main,
  run
};
