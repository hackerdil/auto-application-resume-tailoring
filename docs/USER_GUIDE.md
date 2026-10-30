# User Guide

> Status: partial (Phase 6). Completed in Phase 10.

## Building your fact bank

1. Open **Fact bank** and import your résumé (PDF or .docx, up to 10 MB, text-based, not scanned).
2. Career Agent lists **suggestions**. Each one quotes the exact line from your résumé it came from.
3. For each suggestion, choose **Confirm**, edit the text and choose **Confirm edited fact**, or **Reject**. Only confirmed facts are ever used in résumés or applications.
4. Mark anything personal as **Sensitive**: it is encrypted on disk and kept out of AI prompts unless needed.
5. To fix a confirmed fact later, use **Correct**. The old version is kept in history, never silently changed.
6. You can also **Add a fact yourself**.

## Profile and preferences

- Contact details each have a sharing setting: _Share on applications_, _Ask me each time_, or _Never share_.
- Preferences (target roles, exclusions, locations, work modes, compensation) are used to filter and score jobs (later phases).
- **Saved answers** are answers you write once for recurring questions such as sponsorship or notice period. Career Agent uses only answers you saved and never guesses.

## Finding jobs

1. Open **Sources** and add a company's job board: choose Greenhouse, Lever, or Ashby and enter the board name from its job page URL (for example `jobs.lever.co/<board>`). For Lever's EU site use `eu/<board>`. Optionally give the company name.
2. Choose **Run discovery now**. The background worker reads each enabled board (at most one request per second per site) and reports how many jobs it found. A board that fails shows the reason and does not stop the others.
3. Open **Jobs**:
   - **Eligible** jobs passed your hard filters.
   - **Filtered out** jobs show exactly why: an excluded company or role, a work mode or location outside your preferences, compensation below your stated minimum, a posting older than the freshness limit, or a duplicate of a job already found elsewhere. Missing information never filters a job out.
   - Jobs a board no longer lists are marked **no longer listed**.
4. **Import a job URL** for a single posting. Greenhouse, Lever, and Ashby links are read through their public APIs. For other career sites, tick _Allow the generic career-page reader_: it reads only the structured job data the page publishes. LinkedIn and Indeed links are refused because their terms prohibit automated access.
5. A job's page shows the listed requirements, compensation and visa-sponsorship statements (with the sentence they came from), and the sanitized description.

## Match scores

- New eligible jobs are scored automatically after discovery. You can also use **Score eligible jobs** in the inbox or **Score this job** / **Re-score** on a job page.
- The score is an **internal relevance heuristic** (0–100), not an employer ATS score and not a prediction of being hired.
- The job page shows each of the nine dimensions, its weight, and why it scored as it did. It also lists every requirement as supported, partly supported, not found, or unknown, with the exact facts used as evidence.
- Anything Career Agent does not know (for example whether you need visa sponsorship) scores a neutral 50, is marked _unknown_, and appears under **Needs your input**. Save an answer to "Do you require visa sponsorship?" on the Profile page to have it checked.
- A job is only called **strong** when its listed requirements are actually supported by your facts.
- When your facts, profile, or the posting change, the score is marked **outdated**; re-score to update it.
- Once a job is scored you can **Shortlist** or **Skip** it.

## Tailored résumés

1. On a job's page choose **One page** or **Full**, then **Tailor a résumé**. It is built in the background.
2. Open the version to review it:
   - each line shows whether it was copied, shortened, reworded, or combined from your facts, with the changes highlighted;
   - **Removed by verification** lists generated lines that your facts did not fully support, and why;
   - **Facts not included** lists facts left out for length or relevance;
   - **Rendering checks** confirm the PDF's text is readable by applicant tracking systems, in order, with working links and no cut-off text.
3. **Download PDF** or **Download Word**, then **Approve this résumé** or **Reject** it. Approved versions can be used in applications (later phases). A version whose rendering checks failed cannot be approved; tailor a new one.
4. Only contact details set to _Share on applications_ appear on the résumé.
5. A one-page résumé is shortened by leaving out the least relevant lines, never by shrinking the text.

## Preparing an application

1. On a scored job's page choose **Start an application**. There is one application per job.
2. **Résumé:** pick one of the résumés you approved for this job.
3. **Cover letter:** choose **Draft a cover letter**, read it (each sentence is labelled as coming from your facts, motivation, or standard wording), then **Approve** or **Reject**. You can also tick **Apply without a cover letter**. Without an AI provider the letter states your most relevant achievements verbatim; add your own reasons for applying.
4. **Questions:** add the common set or the questions from the posting. Career Agent sorts them:
   - _Needs your answer_: sensitive questions (work authorization, sponsorship, salary, start date, relocation, background, voluntary self-identification) and anything it does not recognize. It never guesses these.
   - _Check these_: proposals from your profile, saved answers, facts, or verified drafts. Nothing counts until you choose **Use this answer** or write your own.
   - _Answered_: filled from data you explicitly shared, such as profile fields set to _Share on applications_ and your approved files.
   - _You complete these in the form_: consent boxes, legal declarations, signatures, government IDs, and CAPTCHAs. Career Agent never fills them.
5. Saving an answer under **Profile → Saved answers** lets future applications propose it (sensitive ones still need your confirmation each time).
6. **Consistency check** flags problems such as a cover letter that does not name the company, materials made for another job, the same question answered two ways, or facts that changed since a document was written.

7. **Fill the application form:** choose **Prepare in browser**. Career Agent opens the employer's form in a separate window, reads its questions into your list, and fills in only answers you approved, plus your approved résumé and cover letter. It moves through "Next" steps itself and then stops:
   - _Your turn in the browser window_: sign in, enter a verification code, solve a CAPTCHA, or tick consent boxes yourself, then press **Continue**.
   - _Waiting for you_: answer the questions it lists (they appear in your list above), then press **Continue**.
   - _Form filled — ready for your review_: everything is in place. Check the form in the window.
     Career Agent never presses Submit. If you change an answer afterwards, the application goes back to preparing; press **Continue** to refill. **Close browser** closes the window. Your sign-ins are kept in a separate browser profile (`BROWSER_PROFILE_DIR`), never your everyday browser.

8. **Review and approve:** look over the filled form in the browser window. Tick any consent or declaration boxes yourself, then press **Refresh review**. When nothing is listed under _Before you can approve_, tick the confirmation and press **Approve and submit**. Career Agent checks that nothing changed: your answers, your files, the form, the site, and the submit button. It then presses that button once.
   - _Submitted_: the site showed a confirmation. Career Agent keeps the page title and headings as evidence.
   - _The site rejected the form_: nothing was sent. Fix what it shows in the window, refresh the review, and approve again.
   - _Could not tell_: check the window or your email, then choose **It was submitted** or **It was not submitted**. Career Agent never retries on its own.
     An approval is single-use and expires after `APPROVAL_TTL_SECONDS` (5 minutes by default). Changing anything, closing the browser, or restarting Career Agent cancels it. You can also press **Cancel approval** while it is pending.

Nothing is sent to an employer without your approval of that specific application.

## AI providers and usage

**AI & usage** shows which AI services are set up and whether they are working, and what calls have cost over the last day, week, month, or year. Calls without a known price are counted separately; Claude's figure is an estimate that counts against your plan's limits. Everything in Career Agent still works without AI: suggestions are then rule-based, and you write your own reasons for applying.

## Your data

Use **Export my data** for a full copy. To erase everything locally, run `pnpm data:delete --confirm "DELETE MY DATA"`.
