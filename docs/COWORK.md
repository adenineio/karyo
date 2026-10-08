# Getting started in Cowork

Karyo makes visual explainers: short, step-by-step pages that show how something works, one idea at a time. A
topic, a process, a plan, a comparison, a piece of software: anything that's clearer as a picture that builds up.
In Cowork you ask for one in plain words, Claude makes it, checks how every step looks, and saves it as a page in
your folder. No terminal and nothing to install by hand.

## 1. Add Karyo (once)

1. Open the Claude desktop app and go to **Customize › Plugins**.
2. Choose **Add marketplace** and enter `adenineio/adenine`.
3. Find **Karyo** in that marketplace and install it.

Your organisation may manage plugins for you; if you can't add a marketplace, ask whoever runs Claude for your team.

## 2. Make an explainer

1. Start a task in **Cowork** and give it a folder to work in (where your explainers will be saved).
2. Ask for what you want explained, and who it's for. For example:
   - "Make a visual explainer of how a heat pump warms a house, for homeowners."
   - "Walk through our onboarding process step by step, as a visual explainer."
   - "Explain the difference between a loan's interest rate and its APR, visually."
3. The first time in each task, Karyo sets itself up: about a minute. Claude tells you when this happens.
4. Claude plans the steps, draws each one, looks at every step and fixes what doesn't read well. Then it saves the
   explainer in your folder as a single page, such as `How a heat pump works.html`, and shows it to you.

## 3. Open and share it

- **Open** the page from your folder in any web browser. It needs no internet connection. Use the arrow keys (or the
  buttons) to move between steps, **Play** to run through them, and `f` for full screen. The ⚙ menu changes the
  colour scheme.
- **Send** the file to anyone: it's one self-contained page that works on its own.
- **Share a link**: ask Claude to "put this explainer in a Claude artifact". Where Cowork offers artifacts, Claude
  publishes it as a private claude.ai page that you can share, and when it changes the explainer later it updates
  that same page. Where it doesn't, the file in your folder is what you share.

## 4. Change it

Just say what you'd like different, and Claude edits the explainer, checks it again and saves it again:

- "Make step 3 simpler." "Split the last step in two." "Add a step about defrosting."
- "Use this photo in the first step" (add the picture to your folder, or attach it).
- "Show it to me in a dark colour scheme."

The explainer's own files (a `.explainer.json` file and its pictures) sit in a folder next to the page, so you or
Claude can come back to it in a later task.

## Also in Cowork

- **See an example**: ask "show me the Karyo demo". Claude saves a series of 21 short explainers to your folder,
  with a map page to start from.
- **Keep a docket**: say "put this on the docket" for decisions and things to come back to, and "what's on the
  docket?" to see them. Claude can keep the docket in your folder so it lasts beyond the task.

## What doesn't work in Cowork

- **The live project view** (`karyo view`) and **Jarvis voice mode** run a small web server on your own computer,
  which Cowork can't show you. Use them from Claude Code instead. For a project, ask Claude for an explainer of it.

## If something goes wrong

- **"Karyo needs internet access to set itself up"**: Cowork lets organisations turn off internet access for
  Claude's code. Karyo needs it once per task, to download its tools. Ask whoever manages Claude for your team to allow
  it (in the organisation's settings, under Capabilities).
- **Previews can't be shown**: Claude can still build the page; it tells you it couldn't check the steps by eye.
- Anything else: Claude explains what happened in plain words. The technical details are in
  [`PACKAGING.md`](PACKAGING.md) ("Cowork and Claude Desktop").
