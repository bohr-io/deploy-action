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

## Credentials mode (projects in your own Cloudflare account)

A project that runs in its owner's Cloudflare account deploys with `wrangler deploy`, and the workflow bohr writes for it (`.github/workflows/bohr-deploy.yml`) gets the credentials from bohr at run time instead of keeping a Cloudflare token in the repository's secrets:

```yaml
permissions: { contents: read, id-token: write }
jobs:
  deploy:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v5
      - uses: actions/setup-node@v5
      - name: bohr credentials
        id: bohr-credentials
        uses: bohr-io/deploy-action@v1
        with:
          credentials: "true"
      - run: npm ci && npm run build   # sees the build variables
      - run: npx wrangler deploy
        env:
          CLOUDFLARE_API_TOKEN: ${{ steps.bohr-credentials.outputs.cloudflare-api-token }}
          CLOUDFLARE_ACCOUNT_ID: ${{ steps.bohr-credentials.outputs.cloudflare-account-id }}
```

With `credentials: "true"` the action deploys nothing. It requests an OIDC token (audience `bohr.io`), calls `POST <instance-url>/api/deploy/credentials` with it, masks every value it gets back (`::add-mask::`, each build variable included) and then:

- exports the project's build variables (set in the bohr panel, production branch) to the environment of the next steps (`$GITHUB_ENV`), so the install and build see them;
- sets the Cloudflare token and account as the step's outputs `cloudflare-api-token` and `cloudflare-account-id`, so only the step that maps them (the deploy) gets them, not the install and build.

bohr answers only runs of `.github/workflows/bohr-deploy.yml` on a `push` (or `workflow_dispatch`) to the project's production branch, for a project in its owner's Cloudflare account. It hands out the owner's own token (the user's or the organization's Cloudflare connection), never the token of bohr's account: projects bohr hosts are refused.

## Inputs

| Input | Default | Description |
| --- | --- | --- |
| `instance-url` | `https://app.bohr.io` | Base URL of the bohr instance that manages the project. Must use https. |
| `working-directory` | `.` | Folder that holds the project's `wrangler.jsonc`, relative to the repository root. |
| `credentials` | `false` | `"true"`: only get the deploy credentials and build variables of a project in its owner's account (see above). |

## Outputs

| Output | Description |
| --- | --- |
| `url` | URL where the deployed branch is served. |
| `deployment-id` | Identifier of the deployment on the bohr instance. |
| `cloudflare-api-token` | Credentials mode: the Cloudflare API token to deploy with (masked). |
| `cloudflare-account-id` | Credentials mode: the Cloudflare account to deploy to (masked). |

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
| `could not give the deploy credentials (HTTP 403)` | Credentials mode: the message says why. Only `bohr-deploy.yml` on a push to the production branch of a project in its owner's Cloudflare account gets them. |
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
