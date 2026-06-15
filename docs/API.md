# Fitnexia API Documentation (v1)

**Version:** 1.0.0  
**Base URL:** `https://api.fitnexia.com/v1`  
**Staging:** `https://api.staging.fitnexia.com/v1`  
**Format:** JSON (`Content-Type: application/json`)  
**Authentication:** Bearer JWT (except public, auth, and webhook routes)

This API is shared by **web**, **mobile (iOS/Android)**, and the **admin panel**. Clients differ only in OAuth flow, device tokens, and payment UI—not in endpoints.

OpenAPI machine-readable spec: [openapi.yaml](./openapi.yaml)

---

## Table of contents

1. [Clients: web & mobile](#1-clients-web--mobile)
2. [Conventions](#2-conventions)
3. [Authentication](#3-authentication)
4. [Users & profiles](#4-users--profiles)
5. [Search & discovery](#5-search--discovery)
6. [Classes](#6-classes)
7. [Bookings & waitlist](#7-bookings--waitlist)
8. [Payments & subscriptions](#8-payments--subscriptions)
9. [Reviews](#9-reviews)
10. [Loyalty (credits)](#10-loyalty-credits)
11. [Notifications](#11-notifications)
12. [Institution: instructor management](#12-institution-instructor-management)
13. [Metrics & analytics](#13-metrics--analytics)
14. [Support](#14-support)
15. [Administration](#15-administration)
16. [Config & reference data](#16-config--reference-data)
17. [Webhooks](#17-webhooks)
18. [Enums & types](#18-enums--types)
19. [MVP scope](#19-mvp-scope)
20. [Implementation order](#20-suggested-backend-implementation-order)

---

## 1. Clients: web & mobile

| Concern | Web | Mobile (iOS/Android) |
|--------|-----|----------------------|
| API base | Same | Same |
| Auth | `Authorization: Bearer` or httpOnly cookie via BFF | Bearer + secure storage |
| Google OAuth | Browser redirect → callback | Native / Expo → exchange at `POST /auth/oauth/google` |
| Push | Optional web push later | Register FCM at `POST /notifications/devices` |
| File upload | Presigned S3 URL | Same |
| Maps | Google Maps / Mapbox JS | Same API geo fields |
| Payments | Mercado Pago redirect / Brick | MP SDK or hosted checkout + deep link |
| Admin | Primary client | Usually not used |

### Recommended headers

```http
Authorization: Bearer <access_token>
Accept: application/json
Content-Type: application/json
X-Client-Platform: web | ios | android
X-Client-Version: 1.0.0
Accept-Language: en | es
```

### Server configuration (not separate APIs)

- **CORS:** allow web origins (`https://app.fitnexia.com`, `http://localhost:3000` in dev).
- **OAuth:** register web redirect URIs in Google Cloud Console.
- **Mercado Pago:** register web and mobile return URLs.

---

## 2. Conventions

### Pagination

| Param | Default | Max |
|-------|---------|-----|
| `page` | 1 | — |
| `limit` | 20 | 50 |

```json
{
  "data": [],
  "meta": {
    "page": 1,
    "limit": 20,
    "total": 142,
    "totalPages": 8
  }
}
```

### Sorting & filtering

- Filters via query string: `?discipline=yoga&modality=in_person`
- Sort: `sort=price_asc` | `date_asc` | `rating_desc` | `distance_asc`
- Geo: `lat`, `lng`, `radiusKm` (default 10)

### Errors

```json
{
  "error": {
    "code": "BOOKING_CLASS_FULL",
    "message": "This class has no available spots.",
    "details": {}
  }
}
```

| HTTP | Meaning |
|------|---------|
| 400 | Validation error |
| 401 | Missing or invalid token |
| 403 | Wrong role or forbidden resource |
| 404 | Not found |
| 409 | Conflict (duplicate review, class full) |
| 422 | Business rule violation |
| 429 | Rate limit (auth endpoints) |
| 500 | Server error |

### IDs, dates, money

- **IDs:** UUID v4 strings
- **Timestamps:** ISO 8601 UTC (`2026-06-03T14:30:00Z`)
- **Money:** integer minor units (cents) + `currency` (`USD`, `ARS`, …)

### Roles

`athlete` | `instructor` | `institution` | `admin`

---

## 3. Authentication

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| POST | `/auth/register` | — | Email + password registration |
| POST | `/auth/login` | — | Email login |
| POST | `/auth/oauth/google` | — | Google OAuth (token or code) |
| POST | `/auth/refresh` | — | Refresh access token |
| POST | `/auth/logout` | Bearer | Invalidate refresh token |
| POST | `/auth/forgot-password` | — | Send reset email |
| POST | `/auth/reset-password` | — | Reset with token |
| GET | `/auth/me` | Bearer | Current user + profile summary |
| DELETE | `/auth/me` | Bearer | GDPR account deletion |

### Register

`POST /auth/register`

```json
{
  "email": "user@example.com",
  "password": "string",
  "role": "athlete",
  "firstName": "Ana",
  "lastName": "García",
  "acceptTerms": true
}
```

**Response `201`:**

```json
{
  "user": { "id": "uuid", "email": "user@example.com", "role": "athlete" },
  "accessToken": "jwt",
  "refreshToken": "jwt",
  "expiresIn": 3600
}
```

### Login

`POST /auth/login`

```json
{
  "email": "user@example.com",
  "password": "string",
  "deviceToken": "fcm_optional",
  "platform": "ios"
}
```

### Google OAuth

`POST /auth/oauth/google`

```json
{
  "idToken": "google_id_token",
  "role": "instructor",
  "deviceToken": "optional"
}
```

Or authorization code:

```json
{
  "code": "auth_code",
  "redirectUri": "https://app.fitnexia.com/auth/callback"
}
```

---

## 4. Users & profiles

### Athlete

| Method | Path | Auth |
|--------|------|------|
| GET | `/users/me/profile` | athlete |
| PATCH | `/users/me/profile` | athlete |

```json
{
  "firstName": "Ana",
  "lastName": "García",
  "photoUrl": "https://cdn.../photo.jpg",
  "favoriteSports": ["yoga", "crossfit"],
  "locale": "es"
}
```

### Instructor

| Method | Path | Auth |
|--------|------|------|
| GET | `/instructors/me` | instructor |
| PATCH | `/instructors/me` | instructor |
| GET | `/instructors/{id}` | public |
| PATCH | `/instructors/me/availability-now` | instructor |

**Public instructor object:**

```json
{
  "id": "uuid",
  "userId": "uuid",
  "displayName": "Carlos Ruiz",
  "photoUrl": "https://...",
  "bio": "...",
  "disciplines": ["tennis"],
  "certifications": [
    { "name": "PTR Certified", "issuer": "PTR", "year": 2020 }
  ],
  "hourlyRate": { "amount": 5000, "currency": "USD" },
  "verified": true,
  "availableNow": false,
  "averageRating": 4.8,
  "reviewCount": 124,
  "plan": "pro"
}
```

**Available now:** `PATCH /instructors/me/availability-now` → `{ "availableNow": true }`

### Institution

| Method | Path | Auth |
|--------|------|------|
| GET | `/institutions/me` | institution |
| PATCH | `/institutions/me` | institution |
| GET | `/institutions/{id}` | public |

### Verification

| Method | Path | Auth |
|--------|------|------|
| POST | `/verification-requests` | instructor, institution |
| GET | `/admin/verification-requests` | admin |
| POST | `/admin/verification-requests/{id}/approve` | admin |
| POST | `/admin/verification-requests/{id}/reject` | admin |

### Media upload

`POST /media/presign`

```json
{
  "purpose": "avatar",
  "contentType": "image/jpeg",
  "fileName": "photo.jpg"
}
```

**Response:** `{ "uploadUrl", "publicUrl", "expiresAt" }`

---

## 5. Search & discovery

### Search classes

`GET /classes/search`

| Query | Description |
|-------|-------------|
| `q` | Free text (class, instructor, gym name) |
| `discipline` | Sport slug |
| `modality` | `in_person` \| `online` |
| `level` | `beginner` \| `intermediate` \| `advanced` |
| `language` | `es`, `en`, … |
| `instructorGender` | Optional filter |
| `priceMin`, `priceMax` | Minor units |
| `dateFrom`, `dateTo` | ISO date |
| `lat`, `lng`, `radiusKm` | Geo search |
| `sort` | `price_asc`, `date_asc`, `rating_desc`, `distance_asc` |
| `page`, `limit` | Pagination |

### Map markers

`GET /classes/map` — same filters; lightweight `{ id, lat, lng, title, price, startAt }[]` (max 200).

### Home feed (athlete)

`GET /feed/home?lat=&lng=` → `{ recommended, nearby, popular }`

### Search instructors / institutions

- `GET /instructors/search?q=&discipline=`
- `GET /institutions/search?q=&lat=&lng=`

---

## 6. Classes

| Method | Path | Auth |
|--------|------|------|
| POST | `/classes` | instructor, institution |
| GET | `/classes/{id}` | public |
| PATCH | `/classes/{id}` | owner |
| DELETE | `/classes/{id}` | owner |
| POST | `/classes/{id}/cancel` | owner (refunds all bookings) |
| GET | `/classes/mine` | instructor |
| GET | `/institutions/me/classes` | institution |
| GET | `/classes/{id}/bookings` | owner |

### Create class

`POST /classes`

```json
{
  "title": "HIIT Group",
  "description": "...",
  "discipline": "hiit",
  "modality": "in_person",
  "level": "intermediate",
  "language": "es",
  "startAt": "2026-06-10T18:00:00Z",
  "durationMinutes": 45,
  "price": { "amount": 3000, "currency": "USD" },
  "capacity": 20,
  "location": { "address": "...", "lat": -34.6, "lng": -58.4 },
  "institutionId": "optional",
  "instructorId": "required when institution creates",
  "cancellationPolicyHours": 24,
  "recurrence": {
    "enabled": true,
    "frequency": "weekly",
    "weekdays": [1, 3, 5],
    "until": "2026-12-31"
  }
}
```

### Post-MVP

- `GET /classes/{id}/stream` — live streaming room
- `GET /content/recorded` — video on demand

---

## 7. Bookings & waitlist

| Method | Path | Auth |
|--------|------|------|
| POST | `/bookings` | athlete |
| GET | `/bookings/me` | athlete |
| GET | `/bookings/{id}` | participant or owner |
| POST | `/bookings/{id}/cancel` | athlete |
| POST | `/classes/{classId}/waitlist` | athlete |
| POST | `/waitlist/{id}/confirm` | athlete (within 2h window) |
| GET | `/instructors/me/bookings` | instructor |
| GET | `/institutions/me/bookings/dashboard` | institution |

### Create booking

`POST /bookings`

```json
{
  "classId": "uuid",
  "paymentModel": "per_class",
  "useCredits": false,
  "promoCode": null
}
```

**Response `201` (payment required):**

```json
{
  "booking": {
    "id": "uuid",
    "status": "pending_payment",
    "classId": "uuid",
    "price": { "amount": 3000, "currency": "USD" }
  },
  "payment": {
    "provider": "mercado_pago",
    "preferenceId": "...",
    "checkoutUrl": "https://..."
  }
}
```

**Class full `409`:** `{ "error": { "code": "CLASS_FULL", "waitlistAvailable": true } }`

### Booking statuses

`pending_payment` | `confirmed` | `cancelled` | `refunded` | `completed` | `no_show`

### Cancellation rules (server-enforced)

| Case | Result |
|------|--------|
| User cancel > 24h before class | Full refund |
| User cancel < 24h | No refund (or instructor policy) |
| Instructor cancels class | Automatic refund to all users |

---

## 8. Payments & subscriptions

| Method | Path | Auth |
|--------|------|------|
| POST | `/payments/intents` | athlete |
| GET | `/payments/{id}` | owner |
| GET | `/payments/me/history` | athlete |
| GET | `/payouts/me` | instructor, institution |
| GET | `/payouts/me/summary` | instructor, institution |
| GET | `/payouts/me/export.csv` | instructor, institution |
| GET | `/plans` | public |
| POST | `/subscriptions/me` | instructor, institution |
| GET | `/config/payments` | public |

### Payment models

| Value | Description |
|-------|-------------|
| `per_class` | Pay per booking |
| `monthly_unlimited` | Subscription |
| `per_period` | Weekly / monthly / quarterly bundle |

### Commission plans

| Plan | Monthly fee | Commission |
|------|-------------|------------|
| `basic` | Free | 15% |
| `pro` | $29 | 8% |
| `institutional` | $99 | 5% |

**Do not store card data** on Fitnexia servers; use Mercado Pago tokenization only.

---

## 9. Reviews

| Method | Path | Auth |
|--------|------|------|
| GET | `/bookings/{id}/review-eligibility` | athlete |
| POST | `/reviews` | athlete |
| GET | `/instructors/{id}/reviews` | public |
| GET | `/institutions/{id}/reviews` | public |
| POST | `/reviews/{id}/response` | instructor |
| POST | `/reviews/{id}/report` | any authenticated |
| GET | `/admin/reviews/reported` | admin |
| POST | `/admin/reviews/{id}/remove` | admin |

### Create review

`POST /reviews`

```json
{
  "bookingId": "uuid",
  "rating": 5,
  "comment": "Great class"
}
```

Rules: one review per attended booking; **not editable** after publish.

---

## 10. Loyalty (credits)

| Method | Path | Auth |
|--------|------|------|
| GET | `/credits/me` | athlete |
| GET | `/credits/me/transactions` | athlete |

```json
{
  "balance": 7,
  "creditsUntilReward": 3,
  "expiresAt": "2027-06-01T00:00:00Z",
  "lastBookingAt": "2026-05-01T00:00:00Z",
  "freeClassEligible": false,
  "maxFreeClassValue": { "amount": 3000, "currency": "USD" }
}
```

**Rules:** 1 credit per paid booking; 10 credits → free class up to $30; expire 12 months after last booking; not transferable or cash-redeemable. Use `useCredits: true` on booking when eligible.

---

## 11. Notifications

| Method | Path | Auth |
|--------|------|------|
| POST | `/notifications/devices` | Bearer |
| DELETE | `/notifications/devices/{token}` | Bearer |
| GET | `/notifications` | Bearer |
| PATCH | `/notifications/{id}/read` | Bearer |
| POST | `/notifications/read-all` | Bearer |
| GET | `/notifications/preferences` | Bearer |
| PATCH | `/notifications/preferences` | Bearer |

### Device registration (mobile)

```json
{ "token": "fcm_token", "platform": "ios" }
```

### Notification types

`booking_confirmed`, `payment_confirmed`, `class_reminder_24h`, `class_reminder_1h`, `review_invite`, `waitlist_spot`, `credits_expiring`, …

---

## 12. Institution: instructor management

| Method | Path | Auth |
|--------|------|------|
| GET | `/institutions/me/instructors` | institution |
| POST | `/institutions/me/instructors` | institution |
| PATCH | `/institutions/me/instructors/{id}` | institution |
| DELETE | `/institutions/me/instructors/{id}` | institution |
| POST | `/institutions/me/instructors/invite` | institution |

`DELETE` unlinks instructor; does not delete their user account.

---

## 13. Metrics & analytics

| Method | Path | Auth |
|--------|------|------|
| GET | `/institutions/me/metrics` | institution |
| GET | `/instructors/me/metrics` | instructor |
| GET | `/admin/metrics/overview` | admin |

Query: `?period=day|week|month`

---

## 14. Support

| Method | Path | Auth |
|--------|------|------|
| POST | `/support/tickets` | Bearer |
| GET | `/support/tickets/me` | Bearer |

Optional chat: `/support/conversations`, `/support/conversations/{id}/messages`

---

## 15. Administration

Requires `role: admin` (web panel primary).

| Method | Path |
|--------|------|
| GET | `/admin/users` |
| GET | `/admin/users/{id}` |
| PATCH | `/admin/users/{id}` |
| GET | `/admin/verification-requests` |
| POST | `/admin/verification-requests/{id}/approve` |
| POST | `/admin/verification-requests/{id}/reject` |
| GET | `/admin/reviews/reported` |
| POST | `/admin/reviews/{id}/remove` |
| GET | `/admin/metrics/overview` |

---

## 16. Config & reference data

| Method | Path |
|--------|------|
| GET | `/config/disciplines` |
| GET | `/config/countries` |
| GET | `/config/app` |

`/config/app` returns min app versions and feature flags for force-update and toggles.

---

## 17. Webhooks

Server-to-server only; verify provider signatures; process idempotently.

| Provider | Path |
|----------|------|
| Mercado Pago | `POST /webhooks/mercadopago` |

Events: `payment.approved`, `payment.rejected`, `refund`, etc.

---

## 18. Enums & types

```typescript
type UserRole = 'athlete' | 'instructor' | 'institution' | 'admin';
type Modality = 'in_person' | 'online';
type ClassLevel = 'beginner' | 'intermediate' | 'advanced';
type BookingStatus =
  | 'pending_payment'
  | 'confirmed'
  | 'cancelled'
  | 'refunded'
  | 'completed'
  | 'no_show';
type PaymentModel = 'per_class' | 'monthly_unlimited' | 'per_period';
type InstructorPlan = 'basic' | 'pro' | 'institutional';
```

Shared TypeScript types for clients: see `types/api.ts` when added to the repo.

---

## 19. MVP scope

See also [MVP.md](./MVP.md) for mobile feature flags (`constants/features.ts`) and the product matrix.

| In MVP | Post-MVP |
|--------|----------|
| Auth, profiles, search, classes CRUD | Live streaming `/stream` |
| Bookings, cancel, waitlist | Recorded VOD `/content/recorded` |
| Mercado Pago + webhooks, payouts summary | Apple Pay / Google Pay native |
| Reviews, credits | Web push |
| Notifications + FCM | Advanced analytics |
| Institution instructors, basic metrics | — |
| Admin verify + moderate reviews | — |

---

## 20. Suggested backend implementation order

1. Auth + `/auth/me` + role profiles  
2. Classes CRUD + search + feed  
3. Bookings + waitlist + cancellation rules  
4. Mercado Pago + webhooks + payouts  
5. Reviews + credits  
6. Notifications + institution management  
7. Admin + metrics  

---

## Client endpoint checklist (MVP)

### Web & mobile — athlete

| Screen | Endpoints |
|--------|-----------|
| Register / login | `POST /auth/register`, `/auth/login`, `/auth/oauth/google` |
| Home | `GET /feed/home` |
| Search | `GET /classes/search`, `/classes/map` |
| Class detail | `GET /classes/{id}`, `/instructors/{id}` |
| Book | `POST /bookings`, payment redirect |
| My bookings | `GET /bookings/me` |
| Review | `GET /bookings/{id}/review-eligibility`, `POST /reviews` |
| Profile + credits | `GET/PATCH /users/me/profile`, `GET /credits/me` |

### Web & mobile — instructor

| Screen | Endpoints |
|--------|-----------|
| Dashboard | `GET /instructors/me/bookings`, `/classes/mine` |
| Create class | `POST /classes`, `PATCH /classes/{id}` |
| Calendar | `GET /classes/mine` |
| Earnings | `GET /payouts/me`, `/payouts/me/summary` |
| Profile | `GET/PATCH /instructors/me`, `PATCH .../availability-now` |

### Web — institution & admin

| Screen | Endpoints |
|--------|-----------|
| Gym dashboard | `GET /institutions/me/metrics`, `/bookings/dashboard` |
| Instructors | CRUD `/institutions/me/instructors` |
| Admin | `/admin/*` routes |
