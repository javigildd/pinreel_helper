# Helper API contract

PinReel Helper talks to a configurable endpoint via three simple HTTP routes plus a couple of helpers. Any backend implementing this contract can be a destination. Moodly (`https://www.moodly.design`) is one such backend; you can run your own.

The base URL is whatever the user enters in the Settings tab (e.g. `https://example.com/api/external`). All requests use:

```
Authorization: Bearer <token>
```

The token is also user-supplied — see "Bootstrap" below for a recommended way for a backend to provision one without copy-paste.

CORS: extensions send `Origin: chrome-extension://<id>` (or `moz-extension://...`). Your endpoint should respond with `Access-Control-Allow-Origin` reflecting that origin plus `Access-Control-Allow-Credentials: true` for the OPTIONS preflight on `/media`, `/screenshots`, `/queue`, `/canvases`.

## Endpoints

### `GET /queue`

The helper polls this to learn which Pinterest pins your backend wants enriched.

**Request**: standard auth headers, no body.

**Response (200)**:
```json
{
  "pending": [
    { "pinId": "927319379548256259", "pinUrl": "https://www.pinterest.com/pin/927319379548256259/" }
  ],
  "total": 12
}
```

- `pinId`: Pinterest's numeric pin id.
- `pinUrl`: the URL the helper will visit briefly in the user's session to source the animated URL. Must be a `https://*.pinterest.com/pin/...` URL.

If the queue is empty: return `{"pending": [], "total": 0}` and `200`.

### `POST /media`

The helper sends one or more captured URLs.

**Request body**:
```json
{
  "items": [
    {
      "pinId": "927319379548256259",
      "videoUrl": "https://v.pinimg.com/videos/.../mp4_720.mp4",
      "imageUrl": "https://i.pinimg.com/originals/.../...jpg",
      "slides": [
        { "imageUrl": "...", "videoUrl": "..." }
      ]
    }
  ]
}
```

`pinId` is required; the rest are optional. URLs are always `http(s)`; `blob:` and `data:` URLs are stripped client-side.

**Response (200)**: `{"ok": true, "stored": <number>}`.

### `POST /screenshots`

The helper sends a single screenshot the user captured of any webpage.

**Request body**:
```json
{
  "canvasId": "string",
  "imageDataUrl": "data:image/jpeg;base64,...",
  "width": 800,
  "height": 600,
  "title": "optional",
  "sourceUrl": "optional"
}
```

**Response (200)**: include enough to let the helper or website echo the change locally. Suggested shape:
```json
{
  "ok": true,
  "canvasId": "string",
  "pin": { /* arbitrary backend-defined shape */ },
  "elements": [ /* arbitrary backend-defined shape */ ]
}
```

### `GET /canvases`

Returns the list of destinations to which screenshots can be sent. The helper renders this in a dropdown.

**Response (200)**:
```json
{
  "canvases": [
    { "boardId": "string", "name": "string", "updatedAt": "ISO timestamp" }
  ]
}
```

### `GET /whoami`

Sanity check used by the popup to verify the token is good.

**Response (200)**: `{"ok": true, "email": "user@example.com"}`.

## Bootstrap (recommended, optional)

To save the user from copy-paste, a backend can offer a "Connect to PinReel Helper" link on its own web page that, when clicked, sends a `postMessage` from the page to the active tab. The user installs the extension separately; when they click Connect on the backend's page (with the helper installed and the page in an active tab), the page can `postMessage` an object the helper picks up:

```js
window.postMessage({
  source: "moodly",        // or whatever brand
  type: "PINREEL_PROVISION",
  endpoint: "https://your-backend.example.com/api/external",
  token: "the-user's-fresh-token"
}, "*");
```

Implementations should mint short-lived per-device tokens. The helper stores the token and from then on uses it independently of cookies.

## Rate limiting

The helper enforces conservative client-side throttle (configurable per user). Backends are free to enforce server-side limits in addition.
