# margins — GitHub-backed markdown reviewer

A browser-only fork of the [Roughdraft](https://www.roughdraft.md) CriticMarkup editor
with a GitHub data layer. Log in with GitHub, point it at a repo and branch, browse its
markdown files, edit and comment in the Tiptap editor, and save — each save commits the
file back to GitHub via the Contents API, authored as you. There is no backend storage;
the browser talks directly to the GitHub API. The only server-side piece is a stateless
OAuth token exchange: a Vite dev middleware locally, or a Cloudflare Pages Function when
hosted.

---

## 1. GitHub App setup

You need a GitHub App for the OAuth flow. Do this once before running locally or hosting.

1. Go to **GitHub → Settings → Developer settings → GitHub Apps → New GitHub App**.
2. Set a name (e.g. `margins-local`).
3. **Callback URL:** `http://localhost:5173/api/auth/callback`
   _(Add your production URL later when hosting, e.g. `https://<your-domain>/api/auth/callback`.)_
4. Under **Permissions → Repository**:
   - **Contents:** Read and write
   - **Metadata:** Read (required by GitHub, read-only)
5. Uncheck "Expire user authorization tokens" if you want longer sessions (optional).
6. Create the app. Note the **Client ID** shown on the app's settings page.
7. Scroll to **Client secrets** and click **Generate a new client secret**. Copy it immediately.

---

## 2. Local development

```bash
cp app/.env.example app/.env
```

Edit `app/.env` and fill in:

```
GITHUB_CLIENT_ID=<your app's client id>
GITHUB_CLIENT_SECRET=<your client secret>
VITE_GITHUB_MODE=1
```

`VITE_GITHUB_MODE=1` is already set in `.env.example`; keep it.

Install dependencies and start the dev server (run from the repo root or from `app/`):

```bash
cd app
npm install   # first time only
npm run dev
```

Vite starts at **`http://localhost:5173`** by default.

**Flow:**

1. Open `http://localhost:5173`.
2. Click **Login with GitHub** — you are redirected to GitHub for authorization.
3. GitHub redirects back to `/api/auth/callback`. The dev middleware forwards the single-use
   `code` (and `state`) to the SPA via a `/?code=...&state=...` redirect — never the token.
   The SPA verifies `state`, then exchanges the `code` for a user token with a same-origin
   `POST /api/auth/token` (keeping the client secret server-side). The token is returned in
   the JSON response body, stored in `sessionStorage` (tab-scoped), and the `code`/`state`
   query params are stripped from the address bar.
4. The **repo picker** appears. Enter `owner/repo` and a branch; the app lists all `.md`
   files in that repo tree.
5. Click a file — its URL becomes `/?repo=<owner>/<name>&ref=<branch>&path=<file.md>`.
6. Edit and comment in the editor. **Save** commits the file back to GitHub with the
   message `Update <path>`, authored as your GitHub login.

**Run the test suite:**

```bash
npm test
```

(Vitest, runs in `app/`.)

---

## 3. How auth works

GitHub App OAuth, entirely stateless on the server side:

| Step | What happens |
|------|-------------|
| `/api/auth/login` | Server 302s to `https://github.com/login/oauth/authorize` with your Client ID and a `state` nonce. |
| `/api/auth/callback` | Server receives the `code` and `state` from GitHub and 302s to `/?code=<code>&state=<state>` — the single-use code is forwarded to the SPA, never an access token. |
| `POST /api/auth/token` | SPA verifies `state` matches what it generated, then POSTs the `code` here (same-origin). Server exchanges it with GitHub for a user access token (Client secret never leaves the server) and returns it in the JSON response body. |
| SPA | Stores the token in `sessionStorage` and strips `code`/`state` from the URL. All subsequent GitHub API calls (reads, tree listing, commits) are made directly from the browser using `Authorization: Bearer <token>`. |

Comments and commits are attributed to your GitHub username (fetched once from
`GET /user` after login).

---

## 4. Hosting on Cloudflare Pages

The `functions/` directory at the repo root contains the Cloudflare Pages Function that
serves the same `/api/auth/login` and `/api/auth/callback` routes in production.

| Setting | Value |
|---------|-------|
| Build command | `npm run build` _(run in `app/`)_ |
| Build output directory | `app/dist` |
| Functions directory | `functions/` |

**Environment variables** to set in the Pages project dashboard:

| Variable | Where | Value |
|----------|-------|-------|
| `GITHUB_CLIENT_ID` | Plain env var | Your app's Client ID |
| `GITHUB_CLIENT_SECRET` | **Secret** | Your client secret |
| `VITE_GITHUB_MODE` | Build-time env var | `1` |

After deploying, add the production callback URL to your GitHub App:
`https://<your-domain>/api/auth/callback`

---

## 5. Known limits (MVP)

- **No asset/image upload.** The editor's `saveAsset` is disabled in GitHub mode; image
  uploads will error. Use existing hosted URLs in your markdown.
- **Conflicts surfaced but not merged.** If someone else pushed to the file between your
  load and your save, the Contents API returns a SHA mismatch error. The app surfaces this
  as a conflict — reload to get the latest version and re-apply your edits manually.
- **Commits go straight to the selected branch by default.** Saves commit directly to
  whichever branch you selected in the picker (default: repo default branch). Toggle
  **Propose changes** on (per repo) to instead commit to a per-session working branch
  (`margins/<login>/<base>`) and open a Pull Request back to the base — handy when the
  base branch is protected. Uses only the existing `repo` scope; the PR link is shown in
  a toast after saving.
- **Large files.** The GitHub Contents API has a ~1 MB limit per file. Very large markdown
  files may fail to load or save.
