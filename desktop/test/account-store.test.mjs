import assert from 'node:assert/strict';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { loadDist, withTempDir } from './helpers.mjs';

const { ProfileStore } = loadDist('account/profile.js');
const { SecretVault } = loadDist('account/vault.js');

/** Stands in for electron's safeStorage. XOR is not encryption — it only has to be reversible. */
function fakeKeychain({ available = true } = {}) {
  return {
    isEncryptionAvailable: () => available,
    encryptString: (plain) => Buffer.from(plain, 'utf8').map((b) => b ^ 0x5a),
    decryptString: (buf) => Buffer.from(Buffer.from(buf).map((b) => b ^ 0x5a)).toString('utf8'),
  };
}

test('a fresh profile is empty and stores nothing on disk until it is used', async () => {
  await withTempDir(async (dir) => {
    const file = path.join(dir, 'account.json');
    const profile = new ProfileStore(file);

    assert.equal(profile.get().email, null);
    assert.equal(profile.get().hasStoredPassword, false);
    assert.equal(profile.get().autoFill, false);
    assert.equal(existsSync(file), false);
  });
});

test('setting an address names the profile and persists it', async () => {
  await withTempDir(async (dir) => {
    const file = path.join(dir, 'account.json');
    new ProfileStore(file).setEmail('  Someone@Gmail.com  ');

    const reopened = new ProfileStore(file);
    assert.equal(reopened.get().email, 'Someone@Gmail.com', 'trimmed, not otherwise mangled');
    assert.equal(reopened.get().displayName, 'Someone', 'the local part is a sensible default name');
    assert.ok(reopened.get().createdAt > 0);
  });
});

test('an explicit display name is never overwritten by a later address change', async () => {
  await withTempDir(async (dir) => {
    const profile = new ProfileStore(path.join(dir, 'account.json'));
    profile.setDisplayName('Filip');
    profile.setEmail('other@gmail.com');

    assert.equal(profile.get().displayName, 'Filip');
  });
});

test('autofill cannot be turned on without a stored password', async () => {
  await withTempDir(async (dir) => {
    const profile = new ProfileStore(path.join(dir, 'account.json'));

    profile.setAutoFill(true);
    assert.equal(profile.get().autoFill, false, 'nothing to fill with');

    profile.setHasStoredPassword(true);
    profile.setAutoFill(true);
    assert.equal(profile.get().autoFill, true);
  });
});

test('forgetting the password also turns autofill off', async () => {
  await withTempDir(async (dir) => {
    const profile = new ProfileStore(path.join(dir, 'account.json'));
    profile.setHasStoredPassword(true);
    profile.setAutoFill(true);

    profile.setHasStoredPassword(false);

    assert.equal(profile.get().autoFill, false, 'otherwise the UI offers to type a secret that is gone');
  });
});

test('a corrupt profile file falls back to empty rather than crashing the app', async () => {
  await withTempDir(async (dir) => {
    const file = path.join(dir, 'account.json');
    writeFileSync(file, '{ not json');

    assert.equal(new ProfileStore(file).get().email, null);
  });
});

test('a profile file claiming autofill without a password is not trusted', async () => {
  await withTempDir(async (dir) => {
    const file = path.join(dir, 'account.json');
    writeFileSync(file, JSON.stringify({ email: 'a@b.c', autoFill: true, hasStoredPassword: false }));

    assert.equal(new ProfileStore(file).get().autoFill, false);
  });
});

test('clearing wipes the profile', async () => {
  await withTempDir(async (dir) => {
    const file = path.join(dir, 'account.json');
    const profile = new ProfileStore(file);
    profile.setEmail('a@b.c');
    profile.setHasStoredPassword(true);

    profile.clear();

    assert.equal(profile.get().email, null);
    assert.equal(new ProfileStore(file).get().hasStoredPassword, false);
  });
});

test('a stored secret round-trips and is not readable as plaintext on disk', async () => {
  await withTempDir(async (dir) => {
    const file = path.join(dir, 'secret.bin');
    const vault = new SecretVault(file, fakeKeychain());

    assert.equal(vault.has(), false);
    assert.equal(vault.set('hunter2'), true);

    assert.equal(vault.has(), true);
    assert.equal(vault.get(), 'hunter2');
    assert.ok(!readFileSync(file, 'utf8').includes('hunter2'), 'the plaintext is not sitting on disk');
  });
});

test('with no keychain the vault stores nothing at all', async () => {
  await withTempDir(async (dir) => {
    const file = path.join(dir, 'secret.bin');
    const vault = new SecretVault(file, fakeKeychain({ available: false }));

    assert.equal(vault.available(), false);
    assert.equal(vault.set('hunter2'), false, 'refused');
    // The alternative — writing plaintext — would be worse than refusing, because the user would
    // believe the secret was protected.
    assert.equal(existsSync(file), false);
    assert.equal(vault.get(), null);
  });
});

test('clearing the secret removes the file', async () => {
  await withTempDir(async (dir) => {
    const file = path.join(dir, 'secret.bin');
    const vault = new SecretVault(file, fakeKeychain());
    vault.set('hunter2');

    assert.equal(vault.set(null), true);
    assert.equal(existsSync(file), false);
    assert.equal(vault.get(), null);
  });
});

test('a secret the keychain can no longer decrypt reads as absent, not as a crash', async () => {
  await withTempDir(async (dir) => {
    const file = path.join(dir, 'secret.bin');
    new SecretVault(file, fakeKeychain()).set('hunter2');

    const broken = new SecretVault(file, {
      isEncryptionAvailable: () => true,
      encryptString: () => Buffer.alloc(0),
      decryptString: () => {
        throw new Error('wrong key — different OS user, or a restored profile');
      },
    });

    assert.equal(broken.get(), null);
  });
});

test('a keychain that throws on availability is treated as unavailable', async () => {
  await withTempDir(async (dir) => {
    const vault = new SecretVault(path.join(dir, 'secret.bin'), {
      isEncryptionAvailable: () => {
        throw new Error('no dbus');
      },
      encryptString: () => Buffer.alloc(0),
      decryptString: () => '',
    });

    assert.equal(vault.available(), false);
    assert.equal(vault.set('x'), false);
  });
});
