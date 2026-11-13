# Todo Due-Time Notifications — Design

**Status:** design only — not yet implemented
**Trigger:** completing the editable datetime-local UI (commit `c075b5b`).
Now that due dates carry a time component, "remind me when this is due" is
the natural follow-on. The UI input is in place; this doc lays out what
needs to exist on top of it for actual notifications to fire.

## Goal

When a personal todo crosses its due time, Alex gets a notification on
his current device — even when the DevTrail tab is closed. Tap the
notification → opens DevTrail at the todo detail drawer for that row.

Out of scope for this round:
- Email or SMS reminders (notification channel = browser only)
- Cross-device delivery synchronization (deduplicating between desktop +
  phone subscriptions is a follow-on)
- Snooze / repeating reminders (one-shot fire-on-due is enough to start)

## Architecture (one-liner)

`pg-cron`-style server scan finds todos within the next minute,
publishes a Web Push to each registered subscription, the service
worker raises a Notification, click navigates back to the todo.

```
[backend cron]
   └─→ scans todos: due within next minute, status != done, no notif sent yet
       └─→ for each subscription on the user record:
              POST to push endpoint (VAPID-signed)
                 └─→ browser receives push
                       └─→ service worker `push` event
                              └─→ self.registration.showNotification(...)
                                    └─→ user clicks → SW `notificationclick`
                                          └─→ open /?todo=<id> (focuses existing tab if present)
```

Three moving parts:

1. **Frontend:** service worker + permission UX + subscription registration.
2. **Backend:** `push_subscriptions` table, registration endpoint, Web
   Push dispatch on cron tick.
3. **Cron:** runs every minute, scans for `due_date` in the next 60s
   window, marks each delivered todo so it doesn't re-fire on the next
   tick.

## Frontend — service worker + subscription

### Permission UX (deferred ask)

Don't ask on first page load — that's the most-rejected pattern in
browser UX research. Ask in context: when the user sets a due time on
a todo for the first time, surface a one-time prompt:

> "Remind me when this is due → enable notifications"
> [Enable] [Not now]

If declined, store a localStorage flag (`obv2.notifs.declined`) and
don't re-prompt for 30 days. If accepted, request `Notification.permission`
and proceed to subscribe.

### Service worker

Register a worker at `/sw.js` (Vite supports this via the `vite-plugin-pwa`
or manual injection in `main.tsx`). Two events to handle:

```js
// frontend/public/sw.js (sketch)
self.addEventListener('push', (event) => {
  const data = event.data?.json() ?? {};
  event.waitUntil(
    self.registration.showNotification(data.title ?? 'DevTrail', {
      body: data.body,
      data: { todoId: data.todoId },
      tag: data.todoId,        // de-dupe: replaces an earlier reminder for the same todo
      icon: '/icon-192.png',
      badge: '/badge-72.png',
    })
  );
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const todoId = event.notification.data?.todoId;
  event.waitUntil((async () => {
    const all = await clients.matchAll({ type: 'window', includeUncontrolled: true });
    const existing = all.find((c) => c.url.includes(self.location.origin));
    if (existing) {
      existing.focus();
      existing.postMessage({ kind: 'open-todo', todoId });
    } else {
      await clients.openWindow(`/?todo=${todoId}`);
    }
  })());
});
```

Frontend listens for `?todo=<id>` on boot and for `postMessage` from
the SW in the App shell, dispatching the existing `todo-detail` action.

### Subscription registration

After permission is granted:

```ts
const reg = await navigator.serviceWorker.ready;
const sub = await reg.pushManager.subscribe({
  userVisibleOnly: true,
  applicationServerKey: VAPID_PUBLIC_KEY, // injected at build time
});
await api.post('/api/v1/notifications/subscriptions', sub.toJSON());
```

Endpoint stores the subscription server-side, keyed by a stable
device token (random UUID stored in localStorage so the same browser
profile doesn't pile up subscriptions across re-grants).

## Backend

### New table

```sql
CREATE TABLE push_subscriptions (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  device_id    TEXT UNIQUE NOT NULL,    -- stable per browser profile
  endpoint     TEXT UNIQUE NOT NULL,    -- the actual push endpoint URL
  p256dh       TEXT NOT NULL,           -- subscription public key
  auth         TEXT NOT NULL,           -- subscription auth secret
  user_agent   TEXT,                    -- diagnostic only
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_seen_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
```

### New column on todos

```sql
ALTER TABLE todos ADD COLUMN due_notified_at TIMESTAMPTZ;
```

Set when the cron job successfully dispatches a Web Push for that
todo's current `due_date`. If `due_date` changes (user reschedules),
clear `due_notified_at` so the new time gets a new notification.

### Endpoints

- `POST /api/v1/notifications/subscriptions` — register a push subscription.
- `DELETE /api/v1/notifications/subscriptions/:device_id` — unregister
  (e.g. user revoked permission via browser UI).
- `GET /api/v1/notifications/vapid-key` — return the VAPID public key
  so the SPA can subscribe without baking it into bundle config.

### VAPID keys

Generate once via `web-push generate-vapid-keys`. Store the private
key in Azure Key Vault (`your-keyvault/devtrail-vapid-private`),
public key in env var that's safe to ship to the browser.

### Cron tick (every minute)

```sql
SELECT id, content
  FROM todos
 WHERE archived = false
   AND status != 'done'
   AND due_date IS NOT NULL
   AND due_date <= now() + interval '1 minute'
   AND due_date > now() - interval '5 minute'   -- no point firing for stale rows
   AND due_notified_at IS NULL;
```

For each row, fan out to all `push_subscriptions` and dispatch via
`web-push` library:

```ts
await webpush.sendNotification(
  { endpoint, keys: { p256dh, auth } },
  JSON.stringify({
    title: `Due now — ${content}`,
    body: 'Open to mark done or reschedule',
    todoId: id,
  }),
  { vapidDetails: { subject: 'mailto:alex@…', publicKey, privateKey } }
);
```

On 410 Gone or 404 from the push service, drop the subscription —
the user revoked permission or wiped the browser profile.

After successful dispatch, `UPDATE todos SET due_notified_at = now() WHERE id = $1`.

### Where the cron runs

Two options, in order of preference:

1. **In-process scheduler in the existing Node container.** A simple
   `setInterval(60_000, scan)` started at boot. Multi-replica is not a
   concern (single-tenant; we run 1 replica). Survives restarts because
   the query is idempotent + `due_notified_at` makes it self-dedupe.

2. **Azure Function timer trigger.** More moving parts. Only worth it if
   we ever scale to N replicas where in-process schedulers would
   double-fire — which we don't.

Default: option 1.

## Open questions to resolve before implementing

- Lead time. Should reminders fire AT due time, or N minutes before?
  Likely a per-todo or global preference (default = at due, optional
  "10 min before" toggle). Not in v1.
- Repeating reminders. If user dismisses without acting, should we
  re-notify in 30 minutes? v1 says no — one shot, the visual badges
  on Home cover the ongoing reminder.
- Quiet hours. No notifications between (configurable window). Out
  of scope for v1; users can suppress at the OS level.
- Multi-device dedup. If the user has both desktop and phone
  subscribed, both fire. v1 ships duplicate; v2 could mark
  `due_notified_at` on first ack-from-client to silence others.

## Test plan when we build it

- Backend integration: cron scan with mocked time + mocked web-push;
  asserts the right todos are picked up, `due_notified_at` is stamped,
  410-Gone subscriptions are pruned.
- Frontend: subscription registration POSTs the right payload after
  permission grant; the SW path is hard to e2e directly (Playwright
  doesn't drive push notifications), so unit-test the click handler
  against a mocked `clients` API.
- Manual: set due 1 minute out on a real device, close the tab, wait,
  click the notification — verify the todo detail drawer opens.

## Effort estimate

- Backend (table, endpoints, cron, web-push wiring, tests): ~1 day.
- Frontend (SW, permission UX, subscription, route handling): ~1 day.
- VAPID/key vault wiring + ACA env: a few hours.

Roughly a 2-3 day chunk. Worth scheduling against another concrete
trigger like "I missed two due dates this week."
