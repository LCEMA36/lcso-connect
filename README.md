# LCSO Connect — Web Pilot v0.1

Simple internal messaging for the Lafayette County Sheriff's Office. One web page, works on desktop and phone browsers.

**What it does**
- Sign in with email + password (accounts are created by an admin — no public sign-up)
- Groups (All Staff, Command Staff, Captains, Lieutenants, Sergeants, Deputies, CID, Detention Center — add more anytime)
- Per-group access: **Send** (read + post) or **Receive** (read only)
- Routine / Priority / Urgent messages. Urgent pops up full-screen and requires **Acknowledge**; senders and admins see who has and hasn't acknowledged
- Attach PDF, Word, Excel or photos (10 MB max), stored privately
- Live updates and browser alerts while the page is open
- Admin screen: set names, ranks, admin rights, deactivate people, and set group access (one at a time or by rank)

**Files**
| File | Purpose |
|---|---|
| `index.html` | The app |
| `config.js` | Your Supabase address and publishable key |
| `supabase/schema.sql` | Database, security rules, starter groups — run once |

---

## Setup (about 30 minutes)

### 1. Create the Supabase project
1. Go to supabase.com, sign up with a county email, and create a new project (name it `lcso-connect`, region **East US**). Save the database password somewhere safe (not in the code).

### 2. Build the database
1. In the project, open **SQL Editor → New query**.
2. Paste all of `supabase/schema.sql` and click **Run**. You should see "Success."

### 3. Lock down sign-in
1. **Authentication → Sign In / Providers**: turn **off** "Allow new users to sign up." Keep Email enabled.
2. **Authentication → Users → Add user → Create new user**: enter your email and a temporary password, check **Auto Confirm User**.
3. Back in **SQL Editor**, make yourself the admin (change the email):
   ```sql
   update profiles set is_admin = true, full_name = 'Beau Moore', rank = 'Civilian Staff'
   where id = (select id from auth.users where email = 'bmoore@lafayettecoms.com');
   ```

### 4. Connect the app
1. **Project Settings → API Keys**: copy the **Project URL** and the **Publishable key** (older projects call it the "anon public" key).
2. Paste both into `config.js`.

> **About this key:** the publishable key is designed to be visible in a web page — the database security rules are what protect the data (tested: deputies can't post where they're receive-only, can't see other groups, can't promote themselves). **Never** paste the `service_role` / secret key anywhere in these files.

### 5. Put it on GitHub Pages
1. Create a new repo under LCEMA36 (e.g. `lcso-connect`) and upload `index.html`, `config.js` and the `supabase` folder.
2. Repo **Settings → Pages → Deploy from branch → main / root**.
3. The app will be at `https://lcema36.github.io/lcso-connect/`.
4. In Supabase **Authentication → URL Configuration**, set Site URL to that address.

The repo can be public — it contains no passwords or data. The page is marked "noindex" so search engines skip it.

### 6. Add people
1. Supabase **Authentication → Users → Add user** (email + temp password, Auto Confirm). They land in All Staff as receive-only.
2. In the app, click **Admin**: set their name/rank, then set group access (or use **by rank** under a group).
3. They sign in, tap **☰ → Change password**, and tap **Turn on alerts**.

**Phone tip:** in Safari/Chrome, use "Add to Home Screen" so it opens like an app. On iPhone, alerts only work after adding it to the Home Screen.

### 7. Phone notifications (v0.4)
1. Run `supabase/002_push.sql` in the SQL Editor.
2. Supabase → Edge Functions → Deploy a new function → Via Editor. Name it `notify`, paste `supabase/functions/notify/index.ts`, deploy. In the function's Settings, turn **off** "Verify JWT with legacy secret" (the function checks sign-in itself).
3. No keys to enter — the function creates its own notification signing keys on first use and stores them in a server-only table.

**Users turn alerts on once per device:**
- **iPhone (iOS 16.4+):** Safari → Share → **Add to Home Screen** → open LCSO Connect from the icon → **Turn on alerts** → Allow.
- **Android / computer:** open the site in Chrome or Edge → **Turn on alerts** → Allow.
- **☰ menu → Alerts:** choose All messages, Priority + Urgent, or Urgent only; send a test alert.

Notifications follow the phone's Silent/Focus settings (only a native app with Apple Critical Alerts can override them).

---

## Pilot rules (please share with users)
- **No CJI, case details, or personal info about victims, witnesses or suspects.** The free Supabase tier is not CJIS-compliant. Use it for schedules, details, road closures, announcements, and call-outs.
- Alerts reach locked phones once each person turns them on (see step 7). They do not override Silent/Do Not Disturb.
- Deactivate departing employees in **Admin** immediately (unchecking **Active** cuts off access), then delete them in Supabase.

## Known limits (v0.1)
- No password reset email — an admin resets passwords in Supabase (**Users → ⋯ → Reset password** or set a new one).
- Shows the latest 100 messages per group.
- Urgent pop-ups re-appear for 3 days until acknowledged.

## Likely next steps
1. Read receipts
2. Native iPhone/Android app (Capacitor) with Apple Critical Alerts so Urgent can break through Silent mode for Routine messages
3. Move to a CJIS-capable host (e.g. county Microsoft 365 / Azure Government) if case information will be shared
