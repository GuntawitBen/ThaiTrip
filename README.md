# ThaiTrip 🇹🇭

A lightweight web app for keeping a journal of your travels around Thailand.
Click any of the 77 provinces on the map to log a trip with dates, a Google
Photos link, and notes. Visited provinces are coloured in.

Your data lives in your browser's `localStorage` and can be synced to a
**private GitHub Gist** so it survives a new computer.

## Features

- Interactive SVG map of Thailand with all **77 provinces**
- Per-province journal: title, start/end dates, Google Photos link, notes
- Multiple trips per province; provinces shade darker the more you visit
- Province search and visited / not-yet filter
- Recent-trips list and progress stats (`X / 77`)
- Sync via private GitHub Gist (manual or debounced auto-backup)
- One-off JSON export / import as a fallback backup

## Run it locally

It's a static site — no build step.

```bash
# from the repo root
python3 -m http.server 8000
# then open http://localhost:8000
```

(Opening `index.html` directly with `file://` will fail because the app fetches
the GeoJSON; any tiny static server works.)

## Deploy to GitHub Pages

1. Push this repo to GitHub.
2. **Settings → Pages → Build and deployment → Source: `Deploy from a branch`**.
3. Pick the `main` branch (or whichever you prefer) and `/ (root)`.
4. Visit the published URL.

## Setting up Gist sync

1. Create a token at <https://github.com/settings/tokens?type=beta>.
   - **Fine-grained**: only enable **Account permissions → Gists: Read and
     write**. No repository access is needed.
   - Or a classic token with the `gist` scope.
2. In the app click **Settings**, paste the token, optionally tick
   *Auto-backup*, and click **Save token**.
3. Click **Backup to Gist**. The first backup creates a private gist named
   `thaitrip-data.json` and remembers its ID.
4. On a new computer, open the app, paste the same token **and** the Gist ID
   (visible on github.com/yourname?tab=gists), and click **Restore from Gist**.

The token is stored in `localStorage` on the device that uses it. It is not
shared anywhere else. If you ever lose the device, revoke the token from
GitHub.

## Data file

```json
{
  "version": 1,
  "updatedAt": "2025-01-01T00:00:00.000Z",
  "trips": {
    "Chiang Mai": [
      {
        "id": "trip_xxxxx",
        "title": "New Year",
        "startDate": "2025-12-30",
        "endDate": "2026-01-02",
        "googlePhotosUrl": "https://photos.app.goo.gl/...",
        "notes": "Doi Suthep at sunrise."
      }
    ]
  }
}
```

## Credits

- Province boundaries: [`apisit/thailand.json`](https://github.com/apisit/thailand.json)
- Map rendering: [D3.js](https://d3js.org/)
- Styling: [Tailwind CSS](https://tailwindcss.com/) (CDN build)
