# Fitnexia API

Node.js + Express + PostgreSQL backend for the Fitnexia mobile app.

## Setup

```bash
cd backend
npm install
npm run db:migrate
npm run dev
```

API base: **http://localhost:3000/v1**

**Swagger UI:** **http://localhost:3000/docs**

Raw spec: `/docs/openapi.yaml` or `/docs/openapi.json`

## Environment

Copy `.env.example` to `.env`:

```
DATABASE_URL=postgresql://postgres:1234@localhost:5433/fitnexia
PORT=3000
JWT_ACCESS_SECRET=...
JWT_REFRESH_SECRET=...
FRONTEND_URL=http://localhost:8081
```

### Google Sign-In

Google **does not allow** Sign-In inside **Expo Go** (`exp://` redirects → Error 400).

Use a **development build** instead:

```bash
npx expo run:android
# or: npx expo run:ios
```

**Google Cloud Console setup**

1. **OAuth consent screen** — set app name + support email; add your Gmail under **Test users** while in Testing mode.
2. **Web client** — copy client ID to mobile `EXPO_PUBLIC_GOOGLE_WEB_CLIENT_ID` and backend `GOOGLE_CLIENT_IDS`.
3. **Android OAuth client** (required — this fixes `DEVELOPER_ERROR`):
   - Type: **Android** (create a separate client; do not reuse the Web client)
   - Package name: `com.antonia0527.Fitnexia`
   - SHA-1: `5E:8F:16:06:2E:A3:CD:2C:4A:0D:54:78:76:BA:A6:F3:8C:AB:F6:25`
   - (Expo debug keystore at `android/app/debug.keystore` — verify with `npm run google:android-config`)
4. **OAuth consent screen** — add your Gmail under **Test users** (while in Testing mode).

Open the **dev build app** on your device/emulator — not Expo Go.

## MVP endpoints

- **Auth:** `POST /v1/auth/register`, `/login`, `/refresh`, `/logout`, `GET /auth/me`
- **Athlete:** `GET/PATCH /v1/users/me/profile`, `GET /v1/bookings/me`, `POST /v1/bookings`
- **Classes:** `GET /v1/classes/search`, `GET /v1/classes/:id`, `POST /v1/classes`
- **Feed:** `GET /v1/feed/home`
- **Instructor:** `GET/PATCH /v1/instructors/me`
- **Gym:** `GET/PATCH /v1/institutions/me`, `/institutions/me/instructors`
- **Reviews:** `POST /v1/reviews`, `POST /v1/institutions/me/staff-reviews`
- **Admin:** `GET /v1/admin/users`, `/admin/metrics/overview`

See [./docs/API.md](./docs/API.md) for the full contract.
