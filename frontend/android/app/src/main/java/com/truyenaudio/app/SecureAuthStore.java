package com.truyenaudio.app;

import android.content.Context;
import android.content.SharedPreferences;
import android.security.keystore.KeyGenParameterSpec;
import android.security.keystore.KeyProperties;
import android.util.Base64;

import org.json.JSONObject;

import java.nio.ByteBuffer;
import java.nio.charset.StandardCharsets;
import java.security.KeyStore;

import javax.crypto.Cipher;
import javax.crypto.KeyGenerator;
import javax.crypto.SecretKey;
import javax.crypto.spec.GCMParameterSpec;

/** Keystore-backed, app-private persistence for the native authentication blob. */
final class SecureAuthStore {
    private static final String KEY_ALIAS = "truyenaudio_auth_v1";
    private static final String PREFS = "secure_auth";
    private static final String BLOB = "blob";
    private static final String LEGACY_PREFS = "CapacitorStorage";

    private final Context context;

    SecureAuthStore(Context context) {
        this.context = context.getApplicationContext();
    }

    synchronized boolean save(String json) {
        if (json == null || json.isEmpty()) return false;
        try {
            Cipher cipher = Cipher.getInstance("AES/GCM/NoPadding");
            cipher.init(Cipher.ENCRYPT_MODE, getOrCreateKey());
            byte[] encrypted = cipher.doFinal(json.getBytes(StandardCharsets.UTF_8));
            byte[] iv = cipher.getIV();
            ByteBuffer payload = ByteBuffer.allocate(2 + iv.length + encrypted.length);
            payload.put((byte) 1);
            payload.put((byte) iv.length);
            payload.put(iv);
            payload.put(encrypted);
            return context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
                    .edit()
                    .putString(BLOB, Base64.encodeToString(payload.array(), Base64.NO_WRAP))
                    .commit();
        } catch (Exception ignored) {
            return false;
        }
    }

    synchronized String load() {
        String encoded = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
                .getString(BLOB, "");
        if (encoded == null || encoded.isEmpty()) return "";
        try {
            ByteBuffer payload = ByteBuffer.wrap(Base64.decode(encoded, Base64.NO_WRAP));
            if (payload.get() != 1) return "";
            int ivLength = payload.get() & 0xff;
            if (ivLength < 12 || ivLength > 32 || payload.remaining() <= ivLength) return "";
            byte[] iv = new byte[ivLength];
            payload.get(iv);
            byte[] encrypted = new byte[payload.remaining()];
            payload.get(encrypted);
            Cipher cipher = Cipher.getInstance("AES/GCM/NoPadding");
            cipher.init(Cipher.DECRYPT_MODE, getOrCreateKey(), new GCMParameterSpec(128, iv));
            return new String(cipher.doFinal(encrypted), StandardCharsets.UTF_8);
        } catch (Exception ignored) {
            return "";
        }
    }

    synchronized void clear() {
        context.getSharedPreferences(PREFS, Context.MODE_PRIVATE).edit().clear().commit();
    }

    /** Writes the secure blob first and removes legacy Preferences only after commit. */
    synchronized String migrateLegacyPreferences() {
        String existing = load();
        if (!existing.isEmpty()) return existing;
        SharedPreferences legacy = context.getSharedPreferences(LEGACY_PREFS, Context.MODE_PRIVATE);
        String token = legacy.getString("auth_token", "");
        String user = legacy.getString("auth_user", "");
        String refresh = legacy.getString("auth_refresh_token", "");
        if (token == null || token.isEmpty()) return "";
        try {
            JSONObject blob = new JSONObject();
            blob.put("token", token);
            blob.put("refreshToken", refresh == null ? "" : refresh);
            try {
                blob.put("user", new JSONObject(user));
            } catch (Exception ignored) {
                blob.put("user", user == null ? "" : user);
            }
            String json = blob.toString();
            if (!save(json)) return "";
            boolean removed = legacy.edit()
                    .remove("auth_token")
                    .remove("auth_user")
                    .remove("auth_refresh_token")
                    .commit();
            return removed ? json : "";
        } catch (Exception ignored) {
            return "";
        }
    }

    private SecretKey getOrCreateKey() throws Exception {
        KeyStore keyStore = KeyStore.getInstance("AndroidKeyStore");
        keyStore.load(null);
        java.security.Key existing = keyStore.getKey(KEY_ALIAS, null);
        if (existing instanceof SecretKey) return (SecretKey) existing;
        KeyGenerator generator = KeyGenerator.getInstance(
                KeyProperties.KEY_ALGORITHM_AES, "AndroidKeyStore");
        generator.init(new KeyGenParameterSpec.Builder(
                KEY_ALIAS,
                KeyProperties.PURPOSE_ENCRYPT | KeyProperties.PURPOSE_DECRYPT)
                .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
                .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
                .setKeySize(256)
                .build());
        return generator.generateKey();
    }
}
