# Forgotten password or lost authenticator phone

Passwords are never stored in a readable form, so nobody can "look up" a password. Every recovery gives the person a **new one-time
password** that they must change at the next sign-in. Every reset ends all the person's sessions, clears a lockout (5 wrong tries lock an
account for 15 minutes) and is written to the audit log.

## An employee or staff member forgot the password

1. An **Organization Admin or HR** opens the person under **Ажилтнууд**, then the employee page.
2. Next to the login name click **Нууц үг сэргээх** and confirm.
3. A one-time password appears **once**. Give it to the person (in person or by phone, not in a group chat). They sign in with it and
   choose a new password.

HR can reset employees. An Organization Admin can reset HR, Manager and Employee accounts. Nobody resets their own account this way.

## Staff (HR, Manager) forgot the password

An Organization Admin opens **Хэрэглэгчид**, finds the person and clicks **Нууц үг сэргээх** (same one-time password as above). The same page adds HR and Manager accounts, sets which departments and branches a Manager sees (**Хамрах хүрээ**), links an account to the person's own employee record, and disables or re-enables an account when someone leaves or comes back.

## HR or an Organization Admin lost the authenticator phone

An **Organization Admin** opens the person on **Хэрэглэгчид** (or an employee page) and clicks **Authenticator сэргээх**. At the next sign-in the person sets up
the authenticator again (and gets new recovery codes). The person's other recovery codes stop working.

## The only Organization Admin forgot the password or lost the phone

Nobody in the web app can reset an Organization Admin. Use the server console (needs the server login):

```bash
cd ~/work-timekeeper
docker compose --env-file infra/deploy/.env -f infra/deploy/docker-compose.yml exec api \
  node apps/api/dist/cli/reset-password.js --org 310 --username admin
# lost authenticator phone as well: add  --totp
```

It prints a one-time password. The reset is recorded in the audit log as `system:cli`. **Create a second Organization Admin** so this is
rarely needed (`create-user.js --role ORG_ADMIN`); the tool warns when the account is the only one.

## Not built yet

A "Forgot password?" link where the person resets it alone by email or SMS. It needs a verified email or phone number per person and a
message service, which is a new outside service for the privacy register (PRD 15.3).
