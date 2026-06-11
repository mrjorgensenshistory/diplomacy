# Diplomacy — Classroom Edition

A complete online version of the classic board game **Diplomacy** (Europe, 1901)
built for 7-player classroom play. Full standard rules, auto-adjudicated.
Stars ★ are armies, anchors ⚓ are fleets — just like the original board.

- **Students** open `index.html`, type the country code you gave them, and play.
  Every order saves to the server instantly — close the Chromebook mid-turn and
  nothing is lost. Games span as many class periods as they need.
- **You** run everything from `teacher.html` (the "War Room"): create games,
  hand out codes, lock/unlock, resolve turns, undo mistakes, read all the
  secret messages.
- **Can't be played at home:** games are locked by default, unlocks can
  auto-expire after a class period, and a server-side school-hours schedule
  refuses orders outside class even if you forget everything else.

---

## How it fits together

| Piece | Where it lives | What it does |
|---|---|---|
| Game pages (this folder) | GitHub Pages (free) | The map, order entry, dashboard |
| Game state | A Google Sheet on your account | Every game, order, message, and turn — visible and editable by you |
| Brain | Google Apps Script (free) | Validates orders, resolves turns, enforces locks |

There are **two modes**, controlled by one line in `js/config.js`:

- `API_URL: 'MOCK'` — **practice mode** (how it ships). Everything runs inside
  one browser using localStorage. Perfect for trying it yourself or demoing on
  the projector. No setup needed at all — open `teacher.html`, type anything
  as the teacher key, create a game, open `index.html` in another tab and play.
- `API_URL: 'https://script.google.com/...'` — **classroom mode**. Real
  multi-device play, with your Apps Script web app as the server.

---

## Setup, Part 1 — the backend (≈10 minutes, one time)

1. Go to [sheets.new](https://sheets.new) and create a blank Google Sheet.
   Name it something like `Diplomacy Games`.
2. **Extensions → Apps Script.** Delete whatever is in the editor.
3. Copy in the four files (each as its own script file — use the **+** next
   to "Files", choose "Script"):
   - `apps-script/Code.gs` → paste into `Code.gs`
   - `shared/map-data.js` → new file named `map-data`
   - `shared/engine.js` → new file named `engine`
   - `shared/bot.js` → new file named `bot` (the computer players)
4. In `Code.gs`, change the line at the top:
   `var TEACHER_KEY = 'CHANGE-ME-PLEASE';` → pick your own secret (this is
   what you'll type into the War Room — don't share it with students).
5. In the editor toolbar, select the function **`setup`** and click **Run**.
   Approve the permissions when Google asks (it only touches this one sheet).
6. **Deploy → New deployment → ⚙ Web app**:
   - Description: anything
   - Execute as: **Me**
   - Who has access: **Anyone**
   - Click **Deploy**, then copy the **Web app URL** (ends in `/exec`).

## Setup, Part 2 — the website (≈5 minutes)

1. Create a GitHub repository (e.g., `diplomacy`) and upload this whole folder.
2. In `js/config.js`, replace `'MOCK'` with your Web app URL from step 6 above.
3. Repo **Settings → Pages → Deploy from branch → main / root**. Save.
4. Your game is live at `https://YOURNAME.github.io/diplomacy/`
   - Students: `https://YOURNAME.github.io/diplomacy/`
   - You: `https://YOURNAME.github.io/diplomacy/teacher.html`

## Computer players — you don't need 7 humans

When you create a game, it asks **"How many HUMAN players?"** The computer
plays the rest — so 1 kid vs 6 AIs, 5 kids + 2 AIs, anything works. The AI
powers are played by the real leaders of the WW1 era (**Kaiser Wilhelm II,
Tsar Nicholas II, Georges Clemenceau, King George V, Emperor Franz Joseph,
King Victor Emmanuel III, Sultan Mehmed V**), and they play to win:

- They march on supply centers, defend their homeland, support each other's
  attacks, retreat and build like a decent human player.
- **They scheme by mail.** They answer student messages in character, propose
  coalitions against whoever is winning, send sweet-talk across borders, and
  swear revenge when you take their centers. **Nothing they say binds them** —
  their actual orders never read their own mail. They lie. It's Diplomacy.
- Their orders are written server-side at the moment you hit Resolve, so no
  student can ever peek at them.
- On the game's detail page you can flip any country between 🤖 AI and
  👤 human mid-game (kid moves away → the Kaiser takes over; new student
  joins → hand them a code and a country back).

## Running it in class

1. **Create games** in the War Room — one per board ("Period 3 — Board A").
   A class of 28 = four boards of 7. Each game generates country codes for
   its human seats; the AI fills the rest.
2. **Hand out codes** (slips of paper work great). The code is the kid's
   identity — losing it to a rival is an in-game disaster, which they'll learn
   exactly once. Regenerate any code from the dashboard in two clicks.
3. **Start of class:** hit **🔓 Unlock all** — it asks how long until
   auto-relock (default 75 min), so the game locks itself even if you forget.
4. Kids negotiate (out loud and/or by in-game messages — you can read every
   message on the dashboard), then click their units to enter orders.
   The dashboard shows orders in: `5 / 7`.
5. **When time's up:** hit **⚔ Resolve** on each board. Units without orders
   simply hold — an absent kid never blocks the game. Everyone watches the
   arrows on the projector. Drama ensues.
6. **End of class:** **🔒 Lock all** (or let the timer do it).
7. Something went wrong? **↩ Undo last turn** rolls the whole board back.

### Classroom-friendly settings (per game)
- **Centers to win** — official rules say 18; the default here is **12**,
  which produces a winner in roughly half the time.
- **End year** — e.g. 1907: the game ends after Fall 1907 and the most
  supply centers wins. Guarantees the unit fits your calendar.
- **Map style** — teacher-controlled (students can't change it): **Empire**
  (each nation washed in its color — all of Italy looks like Italy, owned
  supply centers in a stronger tint) or **Classic terrain** (the 1976 board
  look). The header has an "apply to all games" switch so your four boards
  stay consistent.
- **Read-only at home** — optional: kids can look at the board and plot,
  but can't submit anything.
- **Auto-resolve** — optional: turn resolves itself when all humans submit
  (the AI never holds things up).

### The school-hours backstop
In the War Room, set the days/hours when play is allowed. The **server**
enforces this — outside those hours every order is refused with "the game
opens during class," regardless of lock state. (Practice mode skips this.)

## Anti-cheating, built in
- A kid's code only controls their own country — the server rejects orders
  for units they don't own, no matter what they do to their browser.
- Illegal moves are rejected server-side (armies can't sail, fleets can't
  enter Bohemia, etc.).
- The board can only be changed by the rules engine. Students never have
  write access to the Google Sheet.
- Every resolved turn is archived (that's what Undo uses), and every message
  is logged with sender, recipient, and turn.

## Tests
The rules engine ships with a test suite (DATC-style rulebook cases —
bounces, cut support, convoy paradoxes, retreats, builds, victory):

```
node tests/run-tests.js     # 159 checks
```

## Credits
Map artwork adapted from ["Diplomacy.svg" by Martin Asal](https://commons.wikimedia.org/wiki/File:Diplomacy.svg),
CC BY-SA 3.0 — see `assets/MAP-LICENSE.txt`. Diplomacy was designed by
Allan B. Calhamer (1959). This is a non-commercial classroom project.
