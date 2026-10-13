# SheetRefresh — Metabase to Google Sheets, refreshed automatically (free)

Pick a saved Metabase question, pick a schedule, and the results land in a Google Sheet tab every hour or every morning. No CSV downloads, no copy-paste, nothing to host.

- **Works with SSO.** Uses a Metabase API key, not your password, so Google/Okta sign-in doesn't break it.
- **Nothing to host.** Runs inside your Google Sheet on Google's own scheduler, even with your browser closed.
- **Your data stays yours.** Results go straight from your Metabase to your Sheet. No third-party server.
- **Refreshes in place.** Charts, formulas and pivot tables that point at the tab keep working.

[![Buy me a coffee](https://img.shields.io/badge/Buy%20me%20a%20coffee-support-yellow?logo=buymeacoffee)](https://buymeacoffee.com/krisshannon)

If this saves you time, a coffee is appreciated. It's free either way.

## What you need

- A Metabase with API keys (**Admin → Settings → Authentication → API Keys**).
- Your Metabase must be reachable from the internet (Metabase Cloud, or self-hosted on a public address). Google's servers make the request, so a Metabase behind a VPN won't work.
- A Google account with Google Sheets.

## Setup (about 5 minutes)

1. **Create an API key in Metabase.** Admin → Settings → Authentication → API Keys → Create. Assign it to a group that can only see the questions this Sheet needs.
2. **Open a Google Sheet** and go to **Extensions → Apps Script**.
3. **Paste the code.** Delete what's in `Code.gs`, paste in [`Code.gs`](Code.gs) from this repo, and click **Save**.
4. **Reload the Sheet.** A **SheetRefresh** menu appears.
5. **SheetRefresh → Connect to Metabase.** Enter your Metabase address and the API key. Google asks you to approve access the first time. Because this is your own copy of the script, Google shows an "unverified app" screen: click **Advanced → Go to (your project)**.
6. **SheetRefresh → Add a question.** Paste a question link (e.g. `https://yourcompany.metabaseapp.com/question/123`) and name the tab it should fill.
7. **SheetRefresh → Refresh all now** to check it works, then **Refresh every hour** or **Refresh every morning**.

You can also add questions by typing straight into the **SheetRefresh** tab: a question link or number in column A and a tab name in column B.

## Good to know

- Each question writes to its own tab and replaces that tab's values on every refresh. Don't type your own notes into those tabs; put them on another tab.
- Questions run with no filter values, using the question's defaults.
- Google Sheets holds up to 10 million cells per spreadsheet. This is meant for reporting-sized results, not full table dumps.
- Your Metabase address and API key are saved in your own Google account (Apps Script user properties), not in the Sheet. Other editors of the Sheet don't see them, and the schedule runs as you.
- To stop: **SheetRefresh → Stop automatic refresh**.

## Coming in a paid version

A one-click install from the Google Workspace Marketplace, email alerts when a refresh fails, and filter values per question. [Email me](mailto:kshannon7@gmail.com?subject=SheetRefresh%20Pro) if you want to hear when it's ready.

## License

MIT. See [LICENSE](LICENSE).

SheetRefresh is an independent project and is not affiliated with or endorsed by Metabase, Inc. or Google LLC.
