-- Signup lowercases emails, so the unique index can't be dodged with Fan@ and fan@.
ALTER TABLE users ADD CONSTRAINT users_email_lowercase CHECK (email = lower(email));
