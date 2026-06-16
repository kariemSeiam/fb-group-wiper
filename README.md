# Group Post Wiper

A Chrome/Brave extension that deletes **every post** from a Facebook group you admin — **any post type, any date** — automatically, in the background, for as long as it takes. Built for old groups with years of history and tens of thousands of posts.

Install once, click **Start**, walk away. It survives browser restarts and resumes exactly where it left off.

---

## How it works (the short version)

Most "delete all" scripts click through the on-screen menu for each post. That's slow and fragile — it breaks whenever a menu is a fraction of a second slow to appear (the "it skips posts" problem).

This extension instead talks to Facebook the same way Facebook's own website does:

1. **Harvest** — asks the group feed for the current batch of posts (a direct data request, no scrolling).
2. **Delete** — sends the exact same "remove post" request the *Remove post → Confirm* button sends, one post at a time.
3. **Repeat** — deleting a post pulls the next-oldest into view, so it keeps draining the group from the top down. It works through the whole history regardless of how old the posts are — no need to scroll back years.
4. **Fallback** — if a particular post type resists that request (some old shared/system posts), it clicks through the real menu like a human, with proper waiting (no more skips).

It also re-reads Facebook's security token periodically so multi-day runs don't silently break, and it logs everything so you can see exactly what happened.

---

## Install (2 minutes)

### 1. Download
Green **Code** button → **Download ZIP** → unzip anywhere. (Or `git clone`.)

### 2. Open Extensions
In Chrome or Brave, go to: `chrome://extensions`

### 3. Enable Developer Mode
Toggle **Developer mode** ON (top-right).

### 4. Load it
Click **Load unpacked** → select the unzipped **`fb-group-wiper`** folder.

Pin the icon from the puzzle-piece menu so you can watch progress.

---

## How to use

1. Log into Facebook in the same browser.
2. Open your group: `facebook.com/groups/YOUR-GROUP`
3. Click the **Group Post Wiper** icon.
4. (Optional) pick a **Speed** — *Safe*, *Balanced* (default), or *Fast*.
5. Click **🗑️ Start Wiping**.
6. Minimize the window and leave it running.

The toolbar icon shows a live **count badge**. Open the popup any time to see the counter, current status, and the **Activity log**.

> **Leave the Facebook tab open.** You can minimize the whole window, but don't close that tab. The extension may refresh the page by itself occasionally — that's normal (it keeps Facebook's session fresh).

### Speed

| Mode | Pace | When to use |
|------|------|-------------|
| **Safe** | slowest | An account you really care about; overnight runs. |
| **Balanced** | default | Recommended for almost everyone. |
| **Fast** | quickest | Smaller groups, or an account you're not worried about. Higher chance Facebook tells it to slow down (it will back off automatically). |

You can change speed mid-run — it applies to the next post.

---

## It runs for as long as it takes

This is built for **slow, safe, unattended** runs:

- Posts are deleted **one at a time**, with a few seconds of randomized spacing between each. This is deliberate — see *Account safety* below.
- Roughly **3–4 seconds per post**:

| Posts   | Approx. time |
|---------|--------------|
| 1,000   | ~1 hour      |
| 10,000  | ~10–12 hours |
| 50,000  | ~2–3 days    |

For a big old group, start it and let it run overnight / over a couple of days. If you close the browser, just reopen it and go back to the group page — it **auto-resumes**.

---

## Account safety (please read)

This tool is intentionally **not** "as fast as possible." Deleting hundreds of posts per minute is exactly what trips Facebook's automated-abuse limits, which can temporarily restrict the account doing it. On an account you care about, that's not worth shaving a few hours.

So it deletes **serially with human-like timing**, and if Facebook ever signals "slow down," it automatically **backs off and waits** (you'll see this in the log), then continues. Let it take its time.

Only run this on a group where you are an **admin** (or moderator with remove rights).

---

## Pause, resume, reset

- **⏸ Pause** — stops cleanly. Click **Start** again to continue from the same count.
- **Auto-resume** — after a browser restart, open the group page; it picks up on its own.
- **Reset counter** — sets the displayed number back to 0 and clears the log/skip list. (Doesn't touch Facebook — only the extension's own counters.)

---

## What gets deleted / what doesn't

- ✅ All normal member and admin posts in the group feed.
- ✅ Your own posts and other people's posts.
- ✅ Works with English and Arabic Facebook.
- ❌ **Members are not affected** — only posts.
- A small number of unusual/system posts may resist deletion; these are recorded in the **skip list** and reported at the end instead of blocking the run.

---

## Honest note on "all" posts

The extension drains the group feed from the top and keeps going until several consecutive checks come back empty. For normal groups this reaches everything. For an extremely large, very old group, watch the first hour and check the **Activity log** — it shows every post id it deletes and any it skips, so you can confirm it's making steady progress and see immediately if it ever stalls. The log + resume mean a multi-day run is always recoverable.

---

## Troubleshooting

| Problem | Fix |
|---|---|
| "Go to a Facebook group first" | Be on `facebook.com/groups/…` before clicking Start. |
| Counter not moving | Open the Activity log. If it says *rate limited*, that's normal — it's waiting and will resume. |
| "Reading page… reload the group" | Refresh the group page (F5); it will continue. |
| Nothing deletes at all | Make sure you're an **admin** of the group, and logged in. |
| Stopped after closing browser | Reopen the browser, go to the group page — it resumes automatically. |

---

## Privacy

Everything runs locally in your browser using your own logged-in session. No data is sent anywhere except to Facebook (the same requests the website itself makes). There is no server, no tracking, no account collection.

---

## Uninstall

`chrome://extensions` → **Group Post Wiper** → **Remove**. Your group is unaffected.
