# HourglassPost

A free **disposable email inbox** website. It's plain HTML, CSS and JavaScript with no build step and no server.

* Opens with a random temporary address, plus **Copy** and **New address** buttons.
* A **Domain** menu lets visitors show the address on any Guerrilla Mail domain (`DOMAINS` in `app.js`). All of them deliver to the same mailbox, so only the shown/copied address changes. The choice is kept in `sessionStorage`.
* The inbox refreshes about every 10 seconds (it pauses while the tab is hidden and slows down after errors), and there's a manual refresh button.
* Messages open in a **sandboxed iframe**: no scripts, no remote images or tracking pixels, and no forms. A **plain-text** view is available too.
* Light and dark mode, responsive, keyboard and screen-reader friendly.
* No ads, no tracking, no cookies of its own. The provider session token is kept in `sessionStorage` only (theme choice in `localStorage`).

## Files

| File | What it is |
|---|---|
| `index.html` | Home page: the inbox, "What is a temporary email?" and the (hidden) support section |
| `how-it-works.html`, `faq.html`, `about.html` | Help pages |
| `privacy.html`, `terms.html` | Privacy policy and terms of use |
| `404.html` | Custom "page not found" page (uses absolute `/hourglasspost/...` paths, because GitHub Pages serves it for any missing URL) |
| `styles.css` | All styles (no web fonts or frameworks) |
| `app.js` | Support settings (top of file), theme toggle, and the inbox logic |
| `vendor/qrcode.js` | [qrcode-generator](https://github.com/kazuhikoarase/qrcode-generator) 2.0.4 by Kazuhiko Arase, MIT licence (see `vendor/LICENSE-qrcode-generator.txt`). Loaded only when a UPI ID is set |
| `favicon.svg`, `favicon-32.png`, `apple-touch-icon.png` | Icons |
| `og-image.png` | 1200x630 social preview image |
| `robots.txt`, `sitemap.xml` | For search engines |

Every page has a shared header and footer (copied into each file; there's no build step). If you add a page, copy an existing one, update its `<title>`, description, canonical/Open Graph URLs, and add it to `sitemap.xml` and the nav lists.

## Support / tip button (hidden until you fill it in)

Open `app.js`. At the very top you'll find:

```js
var SUPPORT = {
  upiId: "",
  bmcUrl: "",
  payeeName: "HourglassPost"
};
```

* **UPI:** put your UPI ID between the quotes, e.g. `upiId: "yourname@okaxis"`. The home page then shows a **Support HourglassPost** card with a **Tip via UPI** button (`upi://pay?pa=...&pn=HourglassPost&cu=INR`, which opens a UPI app on phones) and a QR code made in the browser.
* **Buy Me a Coffee:** put your full page link, e.g. `bmcUrl: "https://buymeacoffee.com/yourname"`. A **Buy me a coffee** button appears.
* You can fill in one or both. A "Support HourglassPost" line also appears in the footer of every page.
* While **both are empty**, every support element stays hidden, so nothing fake appears on the site. Invalid values (a UPI ID without `@`, or a link that isn't `https://`) are ignored.

Then commit and push; GitHub Pages updates in a minute or two.

## SEO

Each page has its own title, meta description, canonical URL (`https://narutouzumakiteam7.github.io/hourglasspost/...`), Open Graph and Twitter tags. JSON-LD: `WebApplication` + `WebSite` on the home page, `FAQPage` on the FAQ, `HowTo` on How it works, and breadcrumbs on the help pages. Note that search engines read `robots.txt` only from the root of a host, so for a `github.io/hourglasspost/` project site submit `sitemap.xml` in Google Search Console instead. If you move to your own domain, update the canonical/OG URLs, `sitemap.xml`, `robots.txt` and the `/hourglasspost/` paths in `404.html`.

No ads, analytics or trackers are included.

All paths are **relative**, so it works from a sub-folder such as `https://<user>.github.io/<repo>/`, and also when you double-click `index.html` on your PC.

## Mail provider

Mailboxes come from **[Guerrilla Mail](https://www.guerrillamail.com/)** through its free public API
(<https://www.guerrillamail.com/GuerrillaMailAPI.html>), under its [Terms of Service](https://www.guerrillamail.com/tos/). Credit is given in the footer.
Please don't poll faster than every 10 seconds, because their terms prohibit over-using their servers.

*mail.tm was checked first. Its API sends CORS headers only to mail.tm's own websites, so a browser blocks it on any other site. Its terms also forbid proxying, so it isn't used.*

## Deploy

Live on GitHub Pages: <https://narutouzumakiteam7.github.io/hourglasspost/> (branch `main`, repo root).
Netlify or Vercel: deploy the folder as a static site, with no build command.
