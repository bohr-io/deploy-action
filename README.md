# bohr.io Cloud deploy action

Deploys a bohr.io Cloud managed project (a Cloudflare Worker, static assets, or both) from GitHub Actions. The project runs in bohr's Cloudflare account, so the workflow needs no Cloudflare token: the action signs in to bohr with the workflow's GitHub OIDC token.

## Usage

```yaml
name: Deploy
on: { push: { branches: ['**'] } }
permissions: { contents: read, id-token: write }
jobs:
  deploy:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v5
      - uses: actions/setup-node@v5
        with: { node-version: 22 }
      - run: npm ci && npm run build   # the project's own build
      - uses: bohr-io/deploy-action@v1
```

- `id-token: write` is required: it lets the action request an OIDC token with audience `bohr.io`, which the bohr instance verifies to find the project for this repository and branch.
- Every pushed branch is deployed to its own hostname; the production branch gets the project's main hostname.
- Run the project's build before the action. The action deploys what the build wrote; it does not install dependencies or build the site.

To use the deployed URL in later steps:

```yaml
      - id: deploy
        uses: bohr-io/deploy-action@v1
      - run: echo "Deployed to ${{ steps.deploy.outputs.url }}"
```

## Inputs

| Input | Default | Description |
| --- | --- | --- |
| `instance-url` | `https://app.bohr.io` | Base URL of the bohr instance that manages the project. Must use https. |
| `working-directory` | `.` | Folder that holds the project's `wrangler.jsonc`, relative to the repository root. |

## Outputs

| Output | Description |
| --- | --- |
| `url` | URL where the deployed branch is served. |
| `deployment-id` | Identifier of the deployment on the bohr instance. |

The job summary shows the URL and how many asset files were found and uploaded.

## Project configuration

The action reads `wrangler.json` or `wrangler.jsonc` (JSON with comments) in `working-directory`. A project that only has `wrangler.toml` must convert it to `wrangler.jsonc` first. When the build generated a config and left `.wrangler/deploy/config.json` pointing at it (as the Cloudflare Vite plugin does), that generated config is used.

```jsonc
{
  "name": "my-site",
  // Optional: leave main out for a static site.
  "main": "src/index.ts",
  "compatibility_date": "2026-10-01",
  "compatibility_flags": ["nodejs_compat"],
  "vars": { "PUBLIC_URL": "https://my-site.example" },
  "assets": {
    "directory": "./dist",
    "binding": "ASSETS",
    "not_found_handling": "single-page-application",
    "html_handling": "auto-trailing-slash",
    "run_worker_first": ["/api/*"]
  }
}
```

| Key | Notes |
| --- | --- |
| `main` | Worker entry point. When set, the action bundles it with `wrangler deploy --dry-run`. |
| `compatibility_date` | Required. |
| `compatibility_flags` | Optional. |
| `vars` | String values only. |
| `assets.directory` | Folder with the static files. Required when `assets` is set. |
| `assets.binding`, `assets.not_found_handling`, `assets.html_handling`, `assets.run_worker_first` | Same meaning as in wrangler. |

Managed projects support static assets, vars and secrets for now. Any other binding (`kv_namespaces`, `d1_databases`, `r2_buckets`, `durable_objects`, `queues`, `services`, `hyperdrive`, `ai` and the rest) stops the deploy with an error. Secrets are set in the bohr panel, never in `wrangler.jsonc`.

The action warns about settings it ignores: `routes` (bohr assigns hostnames), cron `triggers`, `env` sections (the top-level config is deployed) and `assets.base_path`.

### Bundling

When the config has `main`, the action runs, in `working-directory`:

```sh
npx --yes wrangler deploy --dry-run --outdir <temp dir> --config <wrangler config>
```

Add `wrangler` to the project's `devDependencies` to pin its version; otherwise `npx` downloads the latest release. The dry run needs no Cloudflare credentials.

### Static assets

Files in `assets.directory` are hashed exactly as wrangler hashes them, so files Cloudflare already stores for the project are not uploaded again. The action:

- skips files matched by a `.assetsignore` file at the root of the assets directory (gitignore syntax, as in wrangler);
- skips `.assetsignore`, a root `_worker.js` (Pages server code) and symbolic links;
- sends `_redirects` and `_headers` at the root (up to 256 KiB each) as routing rules instead of files, as wrangler does;
- fails on files larger than 25 MiB, the Cloudflare limit.

New and changed files go straight to Cloudflare with an upload token that only allows uploading to this deploy session.

## Troubleshooting

| Error | Fix |
| --- | --- |
| `Could not get a GitHub OIDC token` | Add `permissions: id-token: write` to the workflow or the job. Workflows triggered from forks never get OIDC tokens. |
| `No bohr.io Cloud managed project matches this repository and branch` | Create or migrate the project in the bohr panel, and deploy on branch pushes (not tags or pull requests). |
| `Found wrangler.toml, but this action reads wrangler.jsonc` | Convert the config to `wrangler.jsonc`. |
| `... is not supported` | Remove the binding from the config; managed projects support static assets, vars and secrets. |
| `The assets directory ... does not exist` | Run the build before the action, or fix `assets.directory`. |

## Development

```sh
pnpm --filter @bohr/deploy-action test
pnpm --filter @bohr/deploy-action typecheck
pnpm --filter @bohr/deploy-action build
```

GitHub runs `dist/index.js` straight from the repository, so the bundle is committed: rebuild it after changing `src/`. The protocol between the action and the instance is described in [docs/managed-hosting.md](../../docs/managed-hosting.md).
