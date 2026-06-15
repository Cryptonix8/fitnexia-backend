# Fitnexia Mobile — MVP scope

Source of truth for what ships in **v1** vs later. API contract remains in [`API.md`](./API.md) and [`openapi.yaml`](./openapi.yaml).

Feature flags: [`constants/features.ts`](../constants/features.ts).

## In MVP (mobile)

| Area | Included |
|------|----------|
| Auth | Email + password, role selection, onboarding, password recovery UI |
| Athlete | Basic search (sport, location, modality, schedule, price), book class (mock confirm), booking history, reviews, profile edit |
| Instructor | Profile, publish/edit classes, calendar, availability, Available now, earnings mock |
| Gym | Dashboard, staff, classes, staff reviews, institution profile |
| All | Profile editing, notification **preferences** (not in-app inbox) |
| Payments | **Mock** confirm only — no Mercado Pago / wallets in UI |

## Post-MVP (hidden via feature flags)

| Feature | Flag | Target |
|---------|------|--------|
| Advanced search (level, language, gender) | `advancedSearch` | v2 |
| Map / geolocation | `geolocationMap` | v2 (enabled in dev) |
| Recurring classes | `recurringClasses` | v2 |
| Live streaming | `liveStreaming` | v2 |
| Recorded VOD | `recordedClasses` | v3 |
| Waitlist | `waitlist` | v2 |
| Multi-currency | `multipleCurrencies` | v2 |
| Apple / Google Pay | `digitalWallets` | v2 |
| Monthly / period subscriptions | `subscriptionPaymentModels` | v2 |
| Mercado Pago checkout | `integratedPayments` | v2 |
| Loyalty credits | `loyaltyCredits` | v2 |
| Instructor review replies | `reviewResponses` | v2 |
| In-app notification inbox | `inAppNotificationCenter` | v2 |
| Gym analytics tab | `analyticsMetrics` | v2 |
| Support tickets | `platformSupport` | v2 |
| Saved payment methods | `savedPaymentMethods` | v2 |

## Enabling a feature later

1. Set flag to `true` in `constants/features.ts` (or load from `GET /config/features`).
2. Implement/wire the API client in `services/` (see `services/README.md`).
3. Unhide related UI (search for `useFeature` in the codebase).
4. Update this doc and `docs/API.md` §19 if scope changed.
5. QA the flow end-to-end.

Types in `types/api.ts` already include optional fields for most post-MVP concepts — do not remove them.

## Architecture notes

- **Screens** → **hooks/contexts** → **`services/repositories`** → API (future) / mock (now).
- Do not import `MOCK_*` directly from screens when adding real API calls.
- Do not remove post-MVP types from `types/api.ts`.
