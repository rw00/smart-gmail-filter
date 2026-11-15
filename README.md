# Smart Gmail Filter

A Google Apps Script that filters unread Gmail messages in two stages:
1. **Deterministic Gibberish Filter (`Spam` only)**: Moves emails in the Spam folder from algorithmically generated / gibberish sender domains and addresses directly to Trash without using AI quota.
2. **Gemini AI Classifier (`Inbox` only)**: Evaluates unread Inbox emails with Gemini (`IMPORTANT`, `UNDECIDED`, or `JUNK`). `JUNK` emails are automatically unsubscribed (via RFC 8058 One-Click POST, HTTP GET, or `mailto:`) and moved to Trash; others are tagged with `AI-Reviewed` so they are only processed once.

## Installation (Google Apps Script)

1. **Create the Script**
   - Open [script.google.com](https://script.google.com/) and click **New project**.
   - Replace the contents of `Code.gs` with [`smart_gmail_filter.gs`](smart_gmail_filter.gs).

2. **Configure Your Gemini API Key**
   - Get an API key from [Google AI Studio](https://aistudio.google.com/).
   - In the Apps Script editor, open **Project Settings** (gear icon on the left).
   - Scroll to **Script Properties**, click **Add script property**, and set:
     - **Property**: `GEMINI_API_KEY`
     - **Value**: *your Gemini API key*

3. **Test & Authorize**
   - In the editor toolbar, select `processUnreadEmails` from the function dropdown and click **Run**.
   - Grant the requested Gmail and external request permissions when prompted.

4. **Set Up an Automated Trigger**
   - In the left sidebar, click **Triggers** (alarm clock icon) -> **+ Add Trigger**.
   - Set:
     - **Function to run**: `processUnreadEmails`
     - **Event source**: `Time-driven`
     - **Type of time based trigger**: `Minutes timer` (e.g., every 10 or 15 minutes) or `Hour timer`.

## Running the Gibberish Checker Tests

You can run the test suite in [`test_gibberish.js`](test_gibberish.js) locally with Node.js:

```bash
node test_gibberish.js
```

Or copy [`test_gibberish.js`](test_gibberish.js) into a second file in your Google Apps Script project and run `runGibberishTests`.
