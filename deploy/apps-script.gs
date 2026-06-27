/**
 * Google Apps Script — appends De Jure Academy Messenger leads to a Google Sheet.
 *
 * SETUP
 * 1. Create a Google Sheet. In row 1 add headers: Time | Name | Phone | FB Sender ID | Source
 * 2. Extensions -> Apps Script. Paste this file in. Set SHARED_TOKEN below to a random string
 *    (or leave "" to disable the check) and put the SAME value in the bot's SHEET_SHARED_TOKEN env var.
 * 3. Deploy -> New deployment -> type "Web app".
 *      - Execute as: Me
 *      - Who has access: Anyone
 *    Copy the resulting /exec URL into the bot's GOOGLE_SHEET_WEBAPP_URL env var.
 * 4. Re-deploy (new version) whenever you change this script.
 */

const SHARED_TOKEN = ""; // must match SHEET_SHARED_TOKEN in the bot's .env ("" = no check)

function doPost(e) {
  try {
    const data = JSON.parse(e.postData.contents || "{}");

    if (SHARED_TOKEN && data.token !== SHARED_TOKEN) {
      return ContentService.createTextOutput("forbidden").setMimeType(ContentService.MimeType.TEXT);
    }

    const sheet = SpreadsheetApp.getActiveSpreadsheet().getSheets()[0];
    sheet.appendRow([
      data.time || new Date().toISOString(),
      data.name || "",
      data.phone || "",
      data.senderId || "",
      data.source || "messenger",
    ]);

    return ContentService.createTextOutput("ok").setMimeType(ContentService.MimeType.TEXT);
  } catch (err) {
    return ContentService.createTextOutput("error: " + err).setMimeType(ContentService.MimeType.TEXT);
  }
}
