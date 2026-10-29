# Habits, small tasks and Insights: ideas and proposal

Written 2026-10-29 for the "Today, habits and Insights" part of `SPEC-2026-11.md`. This is a design for Paddy to approve. Nothing is built yet. The mockups are in `docs/mockups/` (open `docs/mockups/index.html`).

What Paddy asked for, in short: one main focus a day, plus small tasks that repeat (30 min job hunting, 10 min fitness) or happen once (grocery shopping, a job interview). He taps them off and sees each week what he planned against what he did. He can plan one week ahead and no further. Habits have n sessions a day or a week, an intention (strict or "just trying"), advice to start low, and optional prompts to step up. Today shows a row of dots for each habit. The Log tab becomes Insights.

The main thing the design has to get right is that **a bad week must not feel like failing**. Every idea below was judged by that.

## 1. What other habit trackers do

### Scoring and streaks

| Idea | Seen in | Fits? | Why |
|---|---|---|---|
| Streak counter ("12 days in a row"), reset to 0 on a miss | Streaks, Way of Life ("chains"), Habitica | **No** | One missed day wipes out weeks of work. This is the most demoralising thing a tracker can do, and it is why people quit them. |
| Habit strength: a score that rises with each session and drops slowly on a miss, with recent sessions weighted more. A short break after a long run costs little. | Loop Habit Tracker (exponential smoothing) | **Partly** | It is forgiving in exactly the right way. But a percentage is hard to explain and reads like a mark at school. Proposal: compute it, show it as a word (Starting, Building, Steady, Strong), never a number. Open question. |
| Weeks on target: "on target 5 of the last 8 weeks" | (our own, close to Loop's bar view) | **Yes** | Easy to read, honest, and a bad week is one week out of eight, not a reset. This is the main number in Insights. |
| Skip or rest days that don't count against you | Loop (skip mark), Streaks, Habitica ("Rest in the Inn"), Finch ("Pause") | **Yes** | Being ill or away is not a miss. The rotation's Away days and a "Pause habit" do this. |
| Streak freeze or forgiveness tokens (0 to 2 a week) | Streak Log, Duolingo | **No** | It patches the streak instead of removing the problem. With no streaks it isn't needed. |
| Damage and health points for a missed daily | Habitica | **No** | Punishment is the opposite of what Paddy wants. |
| Shown as done this week, never as missed | Finch ("no guilt, no pressure") | **Yes** | Today counts up ("2 of 3"). Nothing on Today says "missed". Insights show gaps as a lighter bar, not red. |

### Frequency

| Idea | Seen in | Fits? | Why |
|---|---|---|---|
| Flexible frequency: "3 times a week", any days | Loop, Streaks | **Yes** | Exactly "n sessions a week". No fixed weekdays needed. |
| Several sessions in one day ("2 per day") | Loop (numeric habits), Habitify | **Yes** | "n sessions a day". The dots show today's n. |
| Fixed weekdays (Mon, Wed, Fri) | Streaks, Habitify | **Optional** | Only through "Plan my week", and only as a plan, so a session on Tuesday still counts. |
| Measured amount (minutes, km, reps) instead of yes/no | Loop, Habitify | **Light version** | Each habit has a session size ("30 min") that is shown and used for ramp-up, but a tap means "I did a session", not "I did exactly 30 minutes". Typing numbers on every tap is friction. |

### Starting small and ramping up

| Idea | Seen in | Fits? | Why |
|---|---|---|---|
| Start tiny: "after I brush my teeth, I will floss one tooth" | Tiny Habits (BJ Fogg) | **Yes** | The new-habit form suggests a start size well below the goal and says why. |
| "Start at the right size for you", identity first ("the kind of person you want to become") | Atoms (James Clear) | **Yes, lightly** | The description field can hold the "why". No identity quiz: Paddy wants few clicks. |
| A fixed programme of steps (Couch to 5K: 9 weeks, each a bit harder) | Couch to 5K | **Yes, as a preview** | The form shows the steps from start to goal at the chosen pace, so the ramp is visible up front. The steps are a suggestion; the prompts make each step happen. |
| Automatic increase (+1 rep a day, +10 % a week), holds if you fall short | Climb | **No, ask instead** | Automatic changes take the decision away and can overshoot. Paddy asked for prompts with "Yes, adjust" / "Not now" / "I'm at my goal". The "holds if you fall short" part fits: no prompt while the current level isn't met. |
| Anchor to an existing routine ("after coffee") | Tiny Habits | **Optional field** | Free text in the description. No reminders tied to it. |
| Celebrate right after doing it ("Shine") | Tiny Habits | **Yes, small** | The dot fills with a short, calm animation and a word ("Nice."). No confetti. Off in E-ink and reduced motion. |
| The two-minute rule / a minimum version on hard days | Atomic Habits | **Yes** | Each habit can have a "small version" ("5 min"). Doing it counts as a session. On a hard day, something beats nothing. |

### After a miss

| Idea | Seen in | Fits? | Why |
|---|---|---|---|
| Never miss twice: one miss doesn't matter, try not to make it two | James Clear; Lally et al. 2010 found one missed day did not hurt habit forming | **Yes, as a gentle note** | For committed daily habits only, the day after a miss Today says "Yesterday was a day off. A short one today keeps it going." Never shown for "just trying" habits, never shown twice in a row. |
| Habits take about 66 days on average (18 to 254) | Lally et al. 2010 | **Yes, as advice** | The form says "Give it about two months before judging it." It sets a sensible default for the prompt interval. |
| Step down when it's too much ("make it easier?") | Not common; Finch's lower goals | **Yes** | If a habit is under target for 3 weeks running, Insights (not Today) offer "Make it smaller?" once. It is the mirror of the step-up prompt and avoids quiet abandonment. |
| Pause a habit (holiday, illness) | Finch, Habitica | **Yes** | Paused habits leave Today and are not counted in Insights for those weeks. |

### Gamification

| Idea | Seen in | Fits? | Why |
|---|---|---|---|
| Pets, XP, levels, gold | Finch, Habitica | **No** | Fun for some, but Paddy wants structure, not a game. A small study linked pet rewards to reward-chasing. It also adds lots of UI. |
| Weekly review screen | Way of Life (trends), Atoms (analytics) | **Yes** | Insights → Habits, and the "this week" summary. |

### Sources

- Loop Habit Tracker FAQ: https://github.com/iSoron/uhabits/discussions/689
- Atoms app listing and launch note: https://apps.apple.com/app/id6474421906, https://www.newsfilecorp.com/release/197972/Introducing-Atoms-the-Official-App-of-Atomic-Habits-by-James-Clear
- Tiny Habits summary: https://ruralhealth.utah.gov/wp-content/uploads/Tiny_Habits_Summary.pdf
- Habitica, Rest in the Inn: https://habitica.fandom.com/wiki/Rest_in_the_Inn
- Finch review: https://makeheadway.com/blog/finch-app-review/
- Way of Life: https://wayoflifeapp.com/
- Streaks review: https://leancrew.com/all-this/2018/10/a-few-weeks-with-streaks/
- Climb (automatic progression): https://www.hunted.space/product/climb-3
- Never miss twice (second-hand): https://shoaibahmed.substack.com/p/the-never-miss-twice-principle
- Lally et al. 2010, explained by the author: https://www.surrey.ac.uk/news/does-it-really-take-66-days-form-habit-we-asked-expert-dr-pippa-lally

Some of these are second-hand summaries (store listings, blogs). Nothing above depends on a detail that could not be checked.

## 2. Proposed model

### One clear set of things

Today has three kinds of thing. Each has one name, used the same way in the app, the sheet and these docs.

| Name | What it is | Examples | Done means |
|---|---|---|---|
| **Focus** | The one project the app picks for the day (unchanged). | House renovation, Focus Tracker | A work session, logged with "where I stopped". |
| **Habit** | Anything that repeats: n sessions a day or a week, with an optional session size. | 30 min job hunting (5 a week), 10 min fitness (1 a day), cardio (3 a week) | A tap on a dot. More taps than dots count as extra. |
| **To-do** | A one-off small thing, optionally on a day. | Grocery shopping, attend job interview (Thu) | A tick. It then leaves Today. |

**Yes: repeating small tasks are habits.** "30 min job hunting" and "10 min fitness" need everything a habit has (a count per day or week, planned against done, a size that can grow). Having two kinds of repeating thing would mean two sets of rules for the same need. The difference Paddy feels between "a task I repeat" and "a habit I'm building" is carried by the **intention**, not by a separate type:

- **Committed**: "I'm doing this, 5 a week." Today shows "2 of 5". Insights show on-target weeks. Never-miss-twice notes apply.
- **Just trying**: "Trying it out." Today shows the dots but no "of n". Insights show how often it happened, with no target line and no "on target" count. No miss notes ever. After 4 weeks the app asks once: "Keep it, make it committed, or let it go?"

A plain routine with no wish to grow (say "water the plants, 1 a week") is a committed habit with prompts off.

"Small tasks" stays as the everyday word for the habits and to-dos together, for example as the title of the panel in variant A of the Today mockup.

### How they connect

- A habit can be linked to a **category** (optional). Then its row on Today shows the next action of the top active project in that category, as the daily-minimum panel does now. This is what keeps "job hunting" useful: tap the habit, see what to do next in job search.
- A to-do can be linked to a **project** (optional). It then also shows on that project's page.
- The focus, habits and to-dos are planned in one place: **Plan my week**.
- Everything done lands in **Insights → Logs**, in time order.

### Planned against done

- A habit's plan for a week is its target that week (5 a week, or 1 a day × 7 = 7). If Plan my week put sessions on days, those are the plan for those days, but the weekly total is what counts, so a session moved from Tuesday to Wednesday is still on plan.
- A to-do is planned for the day it has. Done on that day, or before, is on plan. Done later counts as done late (shown as "done Fri", not as a miss).
- Paused habits and Away days are left out of the plan.
- Extra sessions show as "+2 over" in Insights. Over target is good news and is shown as such.

### Plan my week

- Two weeks only: this week and next week. There is no "week after", by design, so it never becomes a calendar.
- One screen, one column per day: the focus lead for the day (the existing weekly rotation's "this week" choice, now also for next week), habit sessions placed on days (tap a day to add a dot), and to-dos dropped on days.
- Nothing has a time of day. No events, no durations on the grid, no repeats beyond what habits already do.
- Opened from Today ("Plan my week") and from a gentle Sunday-evening and Monday-morning banner ("Plan next week? 2 min") that can be turned off.
- Google Calendar is left out. If it comes later, the obvious first step is read-only: show "Job interview 14:00" from the calendar as a to-do on its day.

### Insights (replaces the Log tab)

Sub-tabs, remembered per device:

- **Week**: this week (or last week) at a glance: each habit's done against plan, to-dos done, focus sessions and minutes per day. This is the "per week how often each was planned against done" view. (Proposed as the first sub-tab; the spec lists Logs, Habits, Projects; see open questions.)
- **Habits**: one card per habit: the last 8 or 12 weeks as bars (done against target, the target as a line that steps up when it changed), weeks on target, strength word, size changes over time, extra sessions.
- **Projects**: minutes and sessions per project per week, last touched, skips. Replaces nothing: today this information is only in the Log rows.
- **Logs**: the current session log, plus habit taps and to-dos done, with a filter (All, Sessions, Habits, To-dos, one project).

## 3. Data

Sheet rule from the spec: tabs for people are bright and first, tabs only the app needs are grey and last. Final names and order go into `docs/schema.md` with the schema redesign; this is the habits part of it.

### Habits (bright, for people)

One row per habit. Readable without the app: a person can add a habit by typing a row.

| Column | Example | Notes |
|---|---|---|
| id | `h_7f3a` | Filled in by the app if blank. |
| name | Job hunting | |
| description | Applications, recruiters, LinkedIn. After coffee. | Free text: the why, the anchor. |
| intention | committed | `committed` or `trying`. |
| sessions | 3 | Sessions per period now. |
| per | week | `day` or `week`. |
| size | 30 min | Text, as people write it: "30 min", "2 km", "10 push-ups". The app reads a leading number and unit for ramp-up. |
| small_version | 10 min | Optional. Counts as a session on hard days. |
| goal | 5 a week, 45 min | Optional, where the ramp-up stops. Text, same style. |
| step_up_every | 2 weeks | Blank = no prompts. `1 week` … `6 weeks`, or days. |
| next_prompt | 2026-11-16 | ISO date. The app sets it. |
| prompts | on | `on`, `off`, `at goal`. |
| category | job | Optional link to a category id (shows its top project's next action). |
| status | active | `active`, `paused`, `ended`. |
| started | 2026-11-02 | ISO date. |
| order | 1 | Position on Today. |
| updated_at | | Stamped by `Table`, for offline conflicts. |

### To-dos (bright, for people)

| Column | Example | Notes |
|---|---|---|
| id | `t_19c2` | |
| title | Grocery shopping | |
| day | 2026-10-30 | Optional ISO date. Blank = "anytime", shows on Today until done. |
| done | 2026-10-30 | Blank, or the ISO date it was done. |
| project_id | | Optional. |
| note | Milk, eggs, bin bags | Short text only. |
| order | 3 | |
| created | | |
| updated_at | | |

Name clash: the Kanban table is already called `Tasks`, so this one is `To-dos`.

### Habit log (grey, app only)

One table for everything that happens to a habit over time, so Insights can be rebuilt from it and the Habits tab stays one clean row per habit.

| Column | Example | Notes |
|---|---|---|
| id | | |
| habit_id | `h_7f3a` | |
| day | 2026-10-29 | ISO date the row is about. |
| kind | `done` | `done` (sessions done that day), `plan` (sessions planned that day by Plan my week), `level` (the target and size changed), `prompt` (an answer to a step-up prompt), `pause`, `resume`. |
| count | 2 | For `done` and `plan`. One row per habit per day, updated on each tap, not one row per tap, to keep the tab small. |
| value | 4 a week, 30 min | For `level` (the new level) and `prompt` (`yes`, `not now`, `at goal`). |
| updated_at | | So taps on two devices offline can be merged (counts are added, not overwritten: a special rule in `CONFLICT_TARGETS_`). |

Why `level` rows: Insights must compare each past week with the target that applied then, not today's target.

The focus lead for next week is stored as the rotation's "this week" is now (user properties, keyed by that week's Monday). Sessions stay in the Log tab unchanged.

### Speed

Today needs the habits, this week's `done` and `plan` rows, and to-dos not done. Insights need up to 12 weeks of habit log; it loads when the Insights tab first opens, not in `bootstrap`. A tap updates `FT.store` and the screen first, then calls the server with `{ render: false }` and is queueable offline, as AGENTS.md asks.

## 4. Ramp-up rules

1. **When a habit is made**, the form asks for the goal first ("Where do you want to get to?"), then suggests a start: about a third of the goal's sessions and half its size, rounded down, never below 1 session or 5 minutes. Example: goal 5 × 30 min a week → start 2 × 15 min a week. It says why in one line ("Start lower than you think. You can always add more. Couch to 5K starts with 60 seconds of running.") and shows the steps from start to goal at the chosen pace.
2. **The pace** is "Ask me to step up every …": 1, 2 (default), 3 or 4 weeks, or "Don't ask". For "just trying" habits the default is "Don't ask".
3. **A prompt is only shown when it is earned**: the current level was met in every week since the last change (or ≥ 80 % of sessions, so one missed session doesn't block it). If it isn't met, the prompt waits silently and checks again at the next interval. Nothing says "not yet".
4. **What it offers**: one step, never more: either one more session per period, or a longer session (+5 min under 30 min, else +10 min or about 20 %), never past the goal. If both are possible, the prompt offers both as a choice, with the one that gets closer to the goal in fewer steps pre-selected.
5. **The answers**:
   - **Yes, adjust**: the habit's `sessions` and `size` change from today (this week's target changes too, so you are not suddenly behind: the new target applies from next Monday for weekly habits; daily habits change tomorrow). A `level` row is logged. Next prompt = today + pace.
   - **Not now**: nothing changes. Next prompt = today + pace. After three "Not now" in a row it asks once: "Stop asking for this habit?" (a fine answer).
   - **I'm at my goal**: prompts become `at goal` and stop. The goal is set to the current level. Insights mark the habit "At goal". It can be undone in the habit's settings.
6. **One prompt at a time**, at most one a day, shown as a calm card at the top of the Habits panel on Today, never a pop-up. It can be dismissed with "Not now".
7. **Step down**: if a committed habit is under 50 % of target for 3 weeks running (Away and paused weeks left out), Insights → Habits offers "Make it smaller?" once, with the previous level filled in. Not shown on Today.
8. **Pause** skips the weeks it covers in all of the above.

## 5. The daily minimum becomes a habit

Today the daily minimum is a category (Personal: Job search) plus a yes/no flag for today, with no history.

Migration, done once with the schema migration (backup first):

1. For each mode with a daily-minimum category, add a Habits row: name "Daily minimum: <category label>" (Paddy can rename it, e.g. "Job hunting"), intention `committed`, sessions 1, per `day`, size `10 min`, category = that category, step-up prompts `off` (he can turn them on), started = migration day, order 1.
2. If today's flag is set, add one `done` row for today, so nothing visibly changes on the day of the switch. Older days have no history to move.
3. Remove the "Daily minimum panel" field from the rotation editor and the `dailyMinimum` setting from `MODES` and user properties. The `toggleJob` call and `jobDone` go; the habit tap replaces them.
4. The habit row on Today shows the linked category's top project and its next action, the same rule as now (first active project in sheet order, skipping today's focus unless it is the only one).

A mode with no daily minimum (Work) gets no habit.

## 6. E-ink and accessibility

- Dots: done = filled black circle, not done = hollow ring, extra = a "+1" chip with text. The count is also written ("2 of 3"), so meaning never rests on fill or colour.
- "Just trying" dots have a dashed ring and the word "trying" in the row.
- Over target is shown with "+2 over" text and a hatched bar segment in charts; under target is a lighter bar plus the number. No red anywhere for habits.
- Dots are 32 px (44 px tap area on phone and E-ink), real buttons with labels ("Job hunting: session 3 of 5, not done. Tap to add a session").
- The fill animation and "Nice." are skipped in E-ink and with reduced motion.

## 7. Open questions for Paddy

Answered 2026-10-29: Today variant A; intention is a free-text box (not committed/trying; anything that used it, such as dashed dots for "trying", goes); the prompt title is "Want to go further?"; the rest as drawn. Unanswered questions below use the proposal's default.

1. **Naming**: Focus / Habit / To-do, with "Small tasks" as the panel title for habits and to-dos together. Happy with those words? Is "To-do" right for one-offs, or "Errand", or "One-off"?
2. **Today layout**: one "Small tasks" panel with habits and to-dos together (variant A), or two panels, Habits and To-dos (variant B)?
3. **Dots style**: round dots (A) or a segmented bar with numbers (B)?
4. **Undoing a tap**: proposed: tapping always adds a session; a small "−" next to the count and the usual Undo message take one off. Or should tapping a filled dot empty it?
5. **Habit strength**: show a word (Starting, Building, Steady, Strong) based on a Loop-style score, or only "on target 5 of 8 weeks"?
6. **Step-up prompt**: on Today as a card (variant A, proposed), or a dialog when Today opens (variant B)?
7. **Default pace**: every 2 weeks? And the start-low suggestion of about a third of the sessions and half the size: too cautious, or right?
8. **Insights sub-tabs**: add a **Week** sub-tab first (planned against done for this week) next to Habits, Projects and Logs? Or put the week view at the top of Habits?
9. **Plan my week**: should it be able to change the focus lead for next week (the rotation), or only habits and to-dos?
10. **Sunday/Monday "Plan next week?" banner**: wanted, or only the button?
11. **Never-miss-twice note** for committed daily habits: helpful or nagging?
12. **Habits in Work mode**: allowed (any mode can have habits), or Personal only?
13. **Daily minimum name after migration**: "Daily minimum: job search", or rename it now to "Job hunting, 10 min"?
