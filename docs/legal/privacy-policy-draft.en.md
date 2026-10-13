# Privacy Policy — Timekeeper Work (DRAFT)

> **DRAFT for legal review.** Not to be published until Mongolian legal counsel has approved it and every
> `[bracketed]` item is filled in. It must match the signed employee consent form (`docs/consent/consent-v2-draft.mn.txt`)
> and the product (PRD 15.3). Version: `privacy-v1-draft`. Last updated: [date].

## 1. Who is responsible

Timekeeper Work is an attendance app for employees of an organization that uses it ("your employer"). Your employer decides
why and how your attendance data is used and is the **data controller**. [Operator name, registration number, address]
runs the service for your employer ("we") and acts on your employer's instructions.

Contact for privacy questions: [email] · [phone] · [address]. You can also ask your employer's HR department.

## 2. What we collect

| Data                                                                                             | Why                                                                 | When                                                                          |
| ------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------- | ----------------------------------------------------------------------------- |
| Your name, employee code, department, branch, job title                                          | To identify you and show attendance to the right people             | When HR creates your record                                                   |
| **Arrival and departure events** at your workplace: time, which place, and the location accuracy | To work out whether you were on time, late, left early or absent    | When your phone sees you enter or leave the workplace area                    |
| **Your phone's coordinates and accuracy at the moment of an event**                              | As evidence for the event                                           | With each event; the exact coordinates are erased after [30 days] (section 5) |
| Phone model, operating system version, app version, an app installation identifier               | To tie your account to one phone and to find compatibility problems | At registration and when the app starts                                       |
| App status: whether location permission is on, battery-saver state, last time the app was active | To tell HR when attendance cannot be recorded                       | Regularly while the app runs                                                  |
| Your sign-in name and a hashed password; sign-in times; consent record with date and version     | Account security and proof of consent                               | When you use the account                                                      |

**Location.** While a workplace is on your schedule for the day, the phone checks its position about every 5 minutes and the
system's geofence service reports when you cross the workplace boundary. A notification «Ирцийн бүртгэл ажиллаж байна» (attendance
recording is running) is shown while this runs. The position checks stay on the phone: only arrival and departure events (with the
position at that moment) are sent to the server. We do **not** keep a trail of your movements and we do **not** use location
for anything other than attendance.

We do not collect your contacts, messages, photos, files, advertising ID, or location for advertising. The camera is used only to
scan the registration QR code; no image is stored.

## 3. Why we use it (purpose and legal basis)

Only to calculate attendance: arrival time, departure time, lateness, early leave and absence. We do not use it to track your
movements, for advertising, or sell it to anyone. The basis is your **voluntary, written, signed consent** (the consent form your
employer gave you) and your employer's attendance obligations. [Counsel to confirm the legal basis under the Law on Personal Data
Protection and Labour Law.]

## 4. Who can see it

- Your **HR officer** and your employer's **organization administrator**.
- Your **manager**, only for the branch or department assigned to them, and only attendance information.
- You, in the app («Түүх»): everything recorded about you.
- Our staff only when needed to run or repair the service, with access logged.

We do not sell personal data and do not share it with advertisers.

## 5. How long we keep it

| Data                                            | Kept for                                                   |
| ----------------------------------------------- | ---------------------------------------------------------- |
| Attendance records (arrival, departure, status) | 2 years                                                    |
| Exact coordinates of an event                   | [30 days]; afterwards only the workplace-level event stays |
| App status / heartbeat records                  | [90 days]                                                  |
| Audit log of who looked at or changed data      | at least 12 months                                         |
| Archived employee data                          | as set by your employer and the law                        |

After these periods the data is deleted or anonymized automatically. Backups are encrypted and expire by the same schedule.

## 6. Where it is stored and who processes it

Your data is stored and processed **outside Mongolia**, in [country/region, e.g. Singapore], on servers of [cloud provider name].
It is encrypted in transit and at rest. External services that may receive data, and what they receive:

| Service                                           | Receives                                                                                  | Location               |
| ------------------------------------------------- | ----------------------------------------------------------------------------------------- | ---------------------- |
| [Cloud hosting provider]                          | all data above, encrypted (database, files, backups)                                      | [region]               |
| Google Play services (location)                   | used on your phone to detect the workplace area; Google processes it under its own policy | on the device / Google |
| Google Play Integrity (when enabled)              | device and app integrity signals; no attendance data                                      | Google                 |
| Push notification service (Google FCM / Web Push) | a device token and generic notification text                                              | Google                 |
| [Backup storage provider]                         | encrypted backups                                                                         | [region]               |
| [Email/SMS provider, if used]                     | recipient address and message                                                             | [region]               |

We keep this list current. If the kinds of personal data change, you will be asked for a new consent.

## 7. Your rights

You may: see your attendance history in the app; ask HR to correct wrong records; ask for a copy of your data; ask for it to be
deleted or anonymized when the law allows; and **withdraw your consent** at any time by writing to HR. After withdrawal your phone
stops sending location and your employer records your attendance another way (for example HR enters it manually). Withdrawal must
not lead to any negative treatment. If you are not satisfied you may complain to [the competent authority in Mongolia].

## 8. Security

Encrypted connections (HTTPS), encrypted storage and backups, hashed passwords, two-step sign-in for administrators, access
limited by role and branch, audit logs, and automatic rate limiting against abuse. No system is perfectly secure; if there is a
breach affecting you, your employer and the authority will be informed as the law requires.

## 9. Children

The app is for employees and is not meant for anyone under [18/the legal working age].

## 10. Changes

When we change this policy in a way that matters, we will tell you in the app and, where the data collected changes, ask for your
consent again. The date above shows the latest version.

---

### Before publishing (not part of the policy)

- [ ] Counsel approves the text, in Mongolian first; the English text is a translation.
- [ ] Fill in the controller/operator identity, contact, region and provider names (the pilot server is a DigitalOcean droplet; confirm its region).
- [ ] Confirm that what the policy says is true in the product: erasure of coordinates after 30 days, 90-day heartbeat retention, anonymization jobs, backups expiry. Remove or reword anything not yet built.
- [ ] Put it on a public web page (Play Console requires a URL) that does not need a sign-in.
- [ ] Use the same facts in Play Console's Data safety form (location: collected, not shared, required, encrypted in transit, deletable on request; device ID; app activity).
