# FB Group Post Wiper

A Chrome extension that deletes **all posts** from any Facebook group you admin — automatically, in the background, for as long as it takes.

Built for groups with years of history (2014+). Handles thousands of posts, survives browser restarts, and picks up exactly where it left off.

---

## Install (2 minutes)

### Step 1 — Download
Click the green **Code** button → **Download ZIP** → unzip anywhere on your computer.

### Step 2 — Open Chrome Extensions
Open Chrome and go to: `chrome://extensions`

### Step 3 — Enable Developer Mode
Toggle **Developer mode** ON (top-right corner).

### Step 4 — Load the Extension
Click **Load unpacked** → select the unzipped folder (`fb-group-wiper`).

The extension icon appears in your Chrome toolbar (puzzle piece icon → pin it).

---

## How to Use

1. Log into Facebook
2. Go to your group: `facebook.com/groups/YOUR_GROUP_NAME`
3. Click the **FB Group Post Wiper** icon in Chrome toolbar
4. Click **🗑️ Start Wiping**
5. Walk away

The extension runs in the background. You can minimize the browser window. It will keep deleting posts until the feed is empty, then stop automatically.

---

## Progress

The popup shows a live counter. Close it anytime — the count is saved.

If you close Chrome and reopen it, just go back to the group page and the extension **auto-resumes** from where it stopped.

To check progress anytime: click the extension icon.

---

## Pause & Resume

- Click **⏸ Pause** to stop at any point
- Click **🗑️ Start Wiping** again to resume from the same count
- Click **Reset counter** to start fresh (doesn't affect Facebook — just resets the displayed number)

---

## Requirements

- Chrome browser
- You must be an **admin or moderator** of the group
- Must be logged into Facebook in Chrome
- Keep the Facebook group tab open (can be minimized)

---

## How Long Does It Take?

Each post takes about 3–4 seconds (menu → confirm → wait). Rough estimates:

| Posts | Time |
|-------|------|
| 500   | ~30 min |
| 2,000 | ~2 hours |
| 10,000 | ~10 hours |
| 50,000 | ~2 days |

For very old groups, let it run overnight. It will finish.

---

## Notes

- **Members are NOT affected** — only posts are deleted
- Works with both English and Arabic Facebook UI
- Handles your own posts ("Delete post") and others' posts ("Remove post")
- Very old posts may take multiple passes to surface — the extension handles this automatically with scroll + reload cycles

---

## Troubleshooting

**Button says "Go to a Facebook group first"**
→ Make sure you're on `facebook.com/groups/your-group` before clicking Start

**Extension stops early**
→ Click Start again — it will resume. Facebook sometimes pauses the feed.

**"Reload the Facebook page, then try again"**
→ Refresh the group page (F5), then click Start

**Posts not deleting**
→ Make sure you are an admin of the group (not just a member)

---

## Uninstall

Go to `chrome://extensions` → find **FB Group Post Wiper** → click **Remove**.

Your Facebook group is not affected by uninstalling.
