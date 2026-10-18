# QuickDrop Mail

A free, one-page **disposable email inbox**. It's plain HTML, CSS and JavaScript with no build step and no server.

* Opens with a random temporary address, plus **Copy** and **New address** buttons.
* The inbox refreshes about every 10 seconds (it pauses while the tab is hidden and slows down after errors), and there's a manual refresh button.
* Messages open in a **sandboxed iframe**: no scripts, no remote images or tracking pixels, and no forms. A **plain-text** view is available too.
* Light and dark mode, responsive, keyboard and screen-reader friendly.
* No ads, no tracking, no cookies of its own. The provider session token is kept in `sessionStorage` only (theme choice in `localStorage`).

## Files

| File | What it is |
|---|---|
| `index.html` | The page |
| `styles.css` | All styles (no web fonts or frameworks) |
| `app.js` | Inbox logic (talks to the mail provider from the browser) |

All paths are **relative**, so it works from a sub-folder such as `https://<user>.github.io/<repo>/`, and also when you double-click `index.html` on your PC.

## Mail provider

Mailboxes come from **[Guerrilla Mail](https://www.guerrillamail.com/)** through its free public API
(<https://www.guerrillamail.com/GuerrillaMailAPI.html>), under its [Terms of Service](https://www.guerrillamail.com/tos/). Credit is given in the footer.
Please don't poll faster than every 10 seconds, because their terms prohibit over-using their servers.

*mail.tm was checked first. Its API sends CORS headers only to mail.tm's own websites, so a browser blocks it on any other site. Its terms also forbid proxying, so it isn't used.*

## Deploy (later, only after approval)

GitHub Pages: put these files in the repo root (or `/docs`), then enable *Settings → Pages → Deploy from branch*.
Netlify or Vercel: deploy the folder as a static site, with no build command.
