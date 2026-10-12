// src/main.ts
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { delimiter, dirname, join } from "node:path";
var CLI_PACKAGE = "bohr@latest";
var CLI_PACKAGE_ENV = "BOHR_CLI_PACKAGE";
function invocation(env = process.env, options = {}) {
  const execPath = options.execPath ?? process.execPath;
  const platform = options.platform ?? process.platform;
  const exists = options.exists ?? existsSync;
  const nodeDir = dirname(execPath);
  const npxCli = [
    join(nodeDir, "..", "lib", "node_modules", "npm", "bin", "npx-cli.js"),
    join(nodeDir, "node_modules", "npm", "bin", "npx-cli.js")
  ].find((path2) => exists(path2));
  const pathKey = Object.keys(env).find((key) => key.toUpperCase() === "PATH") ?? "PATH";
  const path = env[pathKey] ?? "";
  const runEnv = { ...env, BOHR_ACTION_CWD: options.cwd ?? process.cwd(), BOHR_ACTION_PATH: path };
  const spec = env[CLI_PACKAGE_ENV]?.trim();
  const npxArgs = spec ? ["--yes", "--package", spec, "bohr", "action"] : ["--yes", CLI_PACKAGE, "action"];
  if (npxCli !== void 0) {
    runEnv[pathKey] = path === "" ? nodeDir : `${nodeDir}${delimiter}${path}`;
    return { command: execPath, args: [npxCli, ...npxArgs], env: runEnv, shell: false };
  }
  return { command: "npx", args: npxArgs, env: runEnv, shell: platform === "win32" };
}
function run(start = invocation()) {
  return new Promise((resolve) => {
    const child = spawn(start.command, start.args, { env: start.env, shell: start.shell, stdio: "inherit" });
    child.once("error", (error) => {
      process.stdout.write(
        `::error::Could not start the bohr CLI with npx (${error.message}). Set up Node.js (actions/setup-node) before this action.
`
      );
      resolve(1);
    });
    child.once("close", (code) => resolve(code ?? 1));
  });
}
if (!process.env.VITEST) {
  void run().then((code) => {
    process.exitCode = code;
  });
}
export {
  CLI_PACKAGE,
  CLI_PACKAGE_ENV,
  invocation,
  run
};
