/*
 * ============================================================
 * CHARRMPASS — ESP32 ENTRY Gate RFID Scanner v3.6 (Dual Hardware SPI)
 *
 * Dedicated firmware for the ENTRY GATE unit with independent SPI buses:
 *   - VSPI Bus (Pins 18, 19, 23, 5): Dedicated to MFRC522 RFID Reader
 *   - HSPI Bus (Pins 26, 14, 12, 13): Dedicated to MicroSD Card Module
 *
 * Features:
 *   - Online Mode: Real-time Supabase verification & Whitelist caching to SD.
 *   - Offline Mode: Fallback to SD Card whitelist when WiFi is lost.
 *   - Offline Logging: Scans during network outage are logged to SD card.
 *   - Auto-Sync: Automatically uploads queued offline scans when WiFi reconnects.
 *
 * Hardware Wiring:
 *   - MFRC522 RFID Reader (VSPI):
 *       SDA/SS: GPIO 5
 *       SCK:    GPIO 18
 *       MOSI:   GPIO 23
 *       MISO:   GPIO 19
 *       RST:    GPIO 27
 *       Power:  3.3V & GND (MUST BE 3.3V)
 *
 *   - MicroSD Card Module (HSPI - Dedicated):
 *       CS:     GPIO 13
 *       MOSI:   GPIO 12
 *       MISO:   GPIO 14
 *       SCK:    GPIO 26
 *       Power:  5V (VIN) & GND
 *
 *   - 16x2 I2C LCD: SDA (GPIO 21), SCL (GPIO 22)
 *   - Green LED: GPIO 4 (Authorized)
 *   - Red LED: GPIO 2 (Denied / Standby)
 *   - Active Buzzer: GPIO 15
 * ============================================================
 */

#define GATE_TYPE "ENTRY"
#define GATE_ID "CHARRMPASS_GATE_ENTRY"

#include <ArduinoJson.h>
#include <FS.h>
#include <HTTPClient.h>
#include <MFRC522.h>
#include <SD.h>
#include <SPI.h>
#include <WiFi.h>
#include <Wire.h>
#include <Preferences.h>
#include <hd44780.h>
#include <hd44780ioClass/hd44780_I2Cexp.h>
#include <esp_wifi.h>   // for esp_wifi_set_ps(WIFI_PS_NONE)

// BLE Libraries
#include <BLEDevice.h>
#include <BLEServer.h>
#include <BLEUtils.h>
#include <BLE2902.h>

// =======================
// BLE PROVISIONING SETTINGS (Standard 128-bit custom UUIDs — never blocked by Web Bluetooth)
// =======================
#define BLE_DEVICE_NAME "CHARRMPASS_ENTRY_BLE"
#define BLE_SERVICE_UUID "4fafc201-1fb5-459e-8fcc-c5c9c331914b"
#define BLE_CHAR_UUID    "beb5483e-36e1-4688-b7f5-ea07361b26a8"

// Wi-Fi credentials are NEVER hardcoded.
// They are loaded exclusively from NVS (saved via Captive Portal or BLE).
String currentSsid = "";
String currentPass = "";

// =======================
// SUPABASE SETTINGS
// =======================
const char *SUPABASE_URL =
    "https://sdwjkgtxrpeajuymgpxp.supabase.co";
const char *SUPABASE_ANON =
    "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9."
    "eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InNkd2prZ3R4cnBlYWp1eW1ncHhwIiwicm9sZSI6Im"
    "Fub24iLCJpYXQiOjE3ODgxMDA0ODEsImV4cCI6MjEwMzY3NjQ4MX0.ZLloaPDBQTMj_"
    "OMTgr5BX6VHqEK7Nc0bFnB7b35d4PA";

// =======================
// HARDWARE PINS — DUAL SPI BUSES
// =======================
// 1. RFID Pins (VSPI)
#define RFID_SS_PIN 5
#define RFID_RST_PIN 27

// 2. SD Card Pins (HSPI - Dedicated)
#define SD_CS_PIN 13
#define SD_MOSI_PIN 12
#define SD_MISO_PIN 14
#define SD_SCK_PIN 26

// 3. Peripherals
#define RED_LED 2
#define GREEN_LED 4
#define BUZZER_PIN 15

// Hardware Instances
MFRC522 rfid(RFID_SS_PIN, RFID_RST_PIN);
SPIClass spiSD(HSPI); // Independent HSPI Controller for SD
hd44780_I2Cexp lcd;
Preferences preferences;

// BLE Server handles
BLEServer* pBleServer = NULL;
BLECharacteristic* pBleCharacteristic = NULL;
bool bleClientConnected = false;
bool bleServerRunning = false;
bool newWifiCredentialsReceived = false;

// =======================
// SD CARD & SCAN STATE
// =======================
bool sdCardReady = false;
const char *WHITELIST_FILE    = "/authorized_cards.csv";
const char *OFFLINE_TXNS_FILE = "/offline_txns.csv";
const char *INSIDE_LIST_FILE  = "/inside_list.txt";
const char *WIFI_CONFIG_FILE  = "/config/wifi.cfg";  // SD Wi-Fi backup

bool card_found = false;
bool card_authorized = false;
String card_name = "";
String card_plate = "";
String card_role = "";
String card_userType = "VEHICLE";
String card_rfidType = "LONG_RANGE";
String card_vehicleId = "";
String card_userId = "";

unsigned long lastScanTime = 0;
const unsigned long SCAN_COOLDOWN = 4000;
bool wifiConnected = false;
unsigned long lastWhitelistSync = 0;
const unsigned long WHITELIST_SYNC_INTERVAL = 300000; // 5 minutes

// =======================
// HELPERS — LCD
// =======================
void lcdMsg(String line1, String line2) {
  lcd.clear();
  lcd.setCursor(0, 0);
  lcd.print(line1.substring(0, 16));
  lcd.setCursor(0, 1);
  lcd.print(line2.substring(0, 16));
}

void showReady() {
  if (wifiConnected) {
    lcdMsg("  SCAN CARD   ", "ENTRY READY...");
  } else if (bleServerRunning) {
    lcdMsg("[BLE SETUP MODE]", "PAIR PHONE/APP");
  } else {
    lcdMsg("  SCAN CARD   ", "[OFFLINE] READY");
  }
  digitalWrite(RED_LED, HIGH);
  digitalWrite(GREEN_LED, LOW);
}

// =======================
// LED BLINK HELPER
// =======================
void blinkLED(int pin, int times) {
  for (int i = 0; i < times; i++) {
    digitalWrite(pin, LOW);
    delay(150);
    digitalWrite(pin, HIGH);
    delay(150);
  }
}

// =======================
// URL-ENCODE UID
// =======================
String urlEncode(String s) {
  String out = "";
  for (unsigned int i = 0; i < s.length(); i++) {
    if (s[i] == ' ')
      out += "%20";
    else
      out += s[i];
  }
  return out;
}

// =======================
// SD CARD INITIALIZATION (HSPI)
// =======================
void initSDCard() {
  pinMode(SD_CS_PIN, OUTPUT);
  digitalWrite(SD_CS_PIN, HIGH);

  // Initialize dedicated HSPI bus for SD Card
  spiSD.begin(SD_SCK_PIN, SD_MISO_PIN, SD_MOSI_PIN, SD_CS_PIN);

  Serial.print("[SD] Initializing SD Card on HSPI (CS 13, MOSI 12, MISO 14, SCK 26)... ");

  if (SD.begin(SD_CS_PIN, spiSD)) {
    sdCardReady = true;
    Serial.println("OK! (SD Card Ready)");

    if (!SD.exists(WHITELIST_FILE)) {
      File f = SD.open(WHITELIST_FILE, FILE_WRITE);
      if (f) {
        f.println("UID,NAME,PLATE,ROLE");
        f.close();
      }
    }
  } else {
    sdCardReady = false;
    Serial.println("FAILED! (Check SD module wiring/card)");
  }
}

// =======================
// SD CARD OFFLINE LOGGING
// =======================
void saveOfflineTransaction(String uid, String status, String remarks) {
  if (!sdCardReady) {
    Serial.println("[SD] Cannot log offline scan: SD card not ready");
    return;
  }

  File f = SD.open(OFFLINE_TXNS_FILE, FILE_APPEND);
  if (f) {
    f.print(uid); f.print(",");
    f.print(GATE_TYPE); f.print(",");
    f.print(status); f.print(",");
    f.print(remarks); f.print(",");
    f.print(card_name.length() > 0 ? card_name : "Unknown"); f.print(",");
    f.println(card_plate.length() > 0 ? card_plate : "--");
    f.close();
    Serial.println("[SD] Logged offline transaction for " + uid);
  }
}

// =======================
// SD CARD WHITELIST CACHE (Download & Store)
// =======================
void syncWhitelistToSD() {
  if (!wifiConnected || !sdCardReady) return;

  Serial.println("[SD SYNC] Updating local whitelist cache from Supabase...");
  String url = String(SUPABASE_URL) + "/rest/v1/rfid_cards?authorization_status=eq.AUTHORIZED"
               "&select=rfid_uid,vehicles(plate_number),users(full_name,role)";

  HTTPClient http;
  http.begin(url);
  http.addHeader("apikey", SUPABASE_ANON);
  http.addHeader("Authorization", String("Bearer ") + SUPABASE_ANON);
  int code = http.GET();

  if (code == 200) {
    String body = http.getString();
    DynamicJsonDocument doc(8192);
    if (deserializeJson(doc, body) == DeserializationError::Ok) {
      JsonArray arr = doc.as<JsonArray>();
      if (arr.size() > 0) {
        File f = SD.open(WHITELIST_FILE, FILE_WRITE);
        if (f) {
          f.println("UID,NAME,PLATE,ROLE");
          for (JsonObject card : arr) {
            String uid = String(card["rfid_uid"] | "");
            String name = "";
            String role = "";
            String plate = "--";
            if (!card["users"].isNull()) {
              name = String(card["users"]["full_name"] | "");
              role = String(card["users"]["role"] | "");
            }
            if (!card["vehicles"].isNull()) {
              plate = String(card["vehicles"]["plate_number"] | "--");
            }
            name.replace(",", " ");
            plate.replace(",", " ");
            f.println(uid + "," + name + "," + plate + "," + role);
          }
          f.close();
          Serial.println("[SD SYNC] Successfully cached " + String(arr.size()) + " authorized cards.");
        }
      }
    }
  }
  http.end();
  lastWhitelistSync = millis();
}

// =======================
// OFFLINE WHITELIST CHECK
// =======================
bool checkAuthorizationOffline(String uid) {
  card_found = false;
  card_authorized = false;
  card_name = "";
  card_plate = "";
  card_role = "";

  if (!sdCardReady || !SD.exists(WHITELIST_FILE)) {
    Serial.println("[SD] Whitelist file not found on SD card");
    return false;
  }

  File f = SD.open(WHITELIST_FILE, FILE_READ);
  if (!f) return false;

  while (f.available()) {
    String line = f.readStringUntil('\n');
    line.trim();
    if (line.startsWith(uid)) {
      card_found = true;
      card_authorized = true;

      int firstComma = line.indexOf(',');
      int secondComma = line.indexOf(',', firstComma + 1);
      int thirdComma = line.indexOf(',', secondComma + 1);

      if (firstComma > 0 && secondComma > 0) {
        card_name = line.substring(firstComma + 1, secondComma);
        if (thirdComma > 0) {
          card_plate = line.substring(secondComma + 1, thirdComma);
          card_role = line.substring(thirdComma + 1);
        } else {
          card_plate = line.substring(secondComma + 1);
        }
      }
      break;
    }
  }
  f.close();
  return card_authorized;
}

// =======================
// AUTO-SYNC OFFLINE TRANSACTIONS TO CLOUD
// =======================
void syncOfflineTransactionsToCloud() {
  if (!wifiConnected || !sdCardReady || !SD.exists(OFFLINE_TXNS_FILE)) return;

  File f = SD.open(OFFLINE_TXNS_FILE, FILE_READ);
  if (!f || f.size() == 0) {
    if (f) f.close();
    return;
  }

  Serial.println("[SYNC] Found offline transactions. Syncing to Supabase...");
  lcdMsg("SYNCING LOGS...", "Please wait...");

  int syncedCount = 0;
  while (f.available()) {
    String line = f.readStringUntil('\n');
    line.trim();
    if (line.length() == 0) continue;

    int c1 = line.indexOf(',');
    int c2 = line.indexOf(',', c1 + 1);
    int c3 = line.indexOf(',', c2 + 1);
    int c4 = line.indexOf(',', c3 + 1);
    int c5 = line.indexOf(',', c4 + 1);

    if (c1 > 0 && c2 > 0 && c3 > 0) {
      String uid = line.substring(0, c1);
      String direction = line.substring(c1 + 1, c2);
      String status = line.substring(c2 + 1, c3);
      String remarks = (c4 > 0) ? line.substring(c3 + 1, c4) : line.substring(c3 + 1);
      String name = (c4 > 0 && c5 > 0) ? line.substring(c4 + 1, c5) : "";
      String plate = (c5 > 0) ? line.substring(c5 + 1) : "";

      String url = String(SUPABASE_URL) + "/rest/v1/transactions";
      HTTPClient http;
      http.begin(url);
      http.addHeader("Content-Type", "application/json");
      http.addHeader("apikey", SUPABASE_ANON);
      http.addHeader("Authorization", String("Bearer ") + SUPABASE_ANON);

      DynamicJsonDocument doc(512);
      doc["rfid_uid"] = uid;
      doc["direction"] = direction;
      doc["gate"] = GATE_ID;
      doc["status"] = status;
      doc["remarks"] = "[OFFLINE SYNC] " + remarks + " (" + name + " / " + plate + ")";

      String body;
      serializeJson(doc, body);
      int code = http.POST(body);
      if (code >= 200 && code < 300) syncedCount++;
      http.end();
      delay(80);
    }
  }
  f.close();

  SD.remove(OFFLINE_TXNS_FILE);
  Serial.println("[SYNC] Synced " + String(syncedCount) + " offline records to cloud.");
  lcdMsg("SYNC COMPLETE", String(syncedCount) + " scans stored");
  delay(1500);
  showReady();
}

// =======================
// ONLINE AUTHENTICATION CHECK
// =======================
bool checkAuthorizationOnline(String uid) {
  card_found = false;
  card_authorized = false;
  card_name = "";
  card_plate = "";
  card_role = "";
  card_vehicleId = "";
  card_userId = "";

  // 1. Check special_tags first (Visitor / Emergency)
  String specialUrl = String(SUPABASE_URL) + "/rest/v1/special_tags?rfid_uid=eq." +
                      urlEncode(uid) + "&select=type,label,description";
  HTTPClient httpSpec;
  httpSpec.begin(specialUrl);
  httpSpec.addHeader("apikey", SUPABASE_ANON);
  httpSpec.addHeader("Authorization", String("Bearer ") + SUPABASE_ANON);
  int specCode = httpSpec.GET();
  if (specCode == 200) {
    String specBody = httpSpec.getString();
    DynamicJsonDocument specDoc(512);
    if (deserializeJson(specDoc, specBody) == DeserializationError::Ok) {
      JsonArray specArr = specDoc.as<JsonArray>();
      if (specArr.size() > 0) {
        card_found = true;
        card_authorized = true;
        String specType = String(specArr[0]["type"] | "VISITOR");
        card_role = specType;
        if (specType == "EMERGENCY") {
          card_name = String(specArr[0]["label"] | "Emergency Vehicle");
          card_plate = "EMERGENCY";
        } else {
          card_name = String(specArr[0]["label"] | "Visitor");
          card_plate = "VISITOR PASS";
        }
        httpSpec.end();
        return true;
      }
    }
  }
  httpSpec.end();

  // 2. Check registered users & vehicles
  String url = String(SUPABASE_URL) + "/rest/v1/rfid_cards?rfid_uid=eq." +
               urlEncode(uid) +
               "&select=authorization_status,vehicle_id,user_id,rfid_type,user_type,"
               "vehicles(plate_number,vehicle_type),"
               "users(full_name,role,default_transit_mode)";

  HTTPClient http;
  http.begin(url);
  http.addHeader("apikey", SUPABASE_ANON);
  http.addHeader("Authorization", String("Bearer ") + SUPABASE_ANON);

  int code = http.GET();
  String body = "";
  if (code == 200) {
    body = http.getString();
  } else {
    http.end();
    return false;
  }
  http.end();

  DynamicJsonDocument doc(1024);
  if (deserializeJson(doc, body) != DeserializationError::Ok) return false;

  JsonArray arr = doc.as<JsonArray>();
  if (arr.size() == 0) return false;

  JsonObject card = arr[0];
  card_found = true;
  card_authorized = (String(card["authorization_status"].as<const char *>()) == "AUTHORIZED");
  card_vehicleId = String(card["vehicle_id"] | "");
  card_userId = String(card["user_id"] | "");
  card_userType = String(card["user_type"] | "VEHICLE");
  card_rfidType = String(card["rfid_type"] | "LONG_RANGE");

  if (!card["vehicles"].isNull()) {
    card_plate = String(card["vehicles"]["plate_number"] | "");
    String vType = String(card["vehicles"]["vehicle_type"] | "");
    if (vType == "None" || card_plate == "PEDESTRIAN") {
      card_userType = "PEDESTRIAN";
      card_rfidType = "CLOSE_RANGE";
    }
  }
  if (!card["users"].isNull()) {
    card_name = String(card["users"]["full_name"] | "");
    card_role = String(card["users"]["role"] | "");
    String defMode = String(card["users"]["default_transit_mode"] | "");
    if (defMode == "PEDESTRIAN") {
      card_userType = "PEDESTRIAN";
      card_rfidType = "CLOSE_RANGE";
    }
  }

  return card_authorized;
}

// =======================
// ONLINE TRANSACTION INSERT
// =======================
void insertTransactionOnline(String uid, String status, String remarks) {
  String url = String(SUPABASE_URL) + "/rest/v1/transactions";

  HTTPClient http;
  http.begin(url);
  http.addHeader("Content-Type", "application/json");
  http.addHeader("apikey", SUPABASE_ANON);
  http.addHeader("Authorization", String("Bearer ") + SUPABASE_ANON);
  http.addHeader("Prefer", "return=minimal");

  DynamicJsonDocument doc(512);
  doc["rfid_uid"] = uid;
  doc["direction"] = GATE_TYPE;
  doc["gate"] = GATE_ID;
  doc["status"] = status;
  doc["remarks"] = remarks;
  doc["user_type"] = card_userType;
  doc["rfid_type"] = card_rfidType;

  if (card_vehicleId.length() > 0 && card_vehicleId != "null")
    doc["vehicle_id"] = card_vehicleId;
  if (card_userId.length() > 0 && card_userId != "null")
    doc["user_id"] = card_userId;

  String body;
  serializeJson(doc, body);
  http.POST(body);
  http.end();
}

// =======================
// ONLINE DUPLICATE ENTRY CHECK
// =======================
bool checkDuplicateEntryOnline(String uid, String &conflictDetail) {
  String url = String(SUPABASE_URL) + "/rest/v1/transactions?rfid_uid=eq." +
               urlEncode(uid) +
               "&status=eq.AUTHORIZED&order=timestamp.desc&limit=1&select=direction,timestamp";

  HTTPClient http;
  http.begin(url);
  http.addHeader("apikey", SUPABASE_ANON);
  http.addHeader("Authorization", String("Bearer ") + SUPABASE_ANON);

  int code = http.GET();
  String body = "";
  if (code == 200) body = http.getString();
  http.end();

  if (body.length() == 0 || body == "[]") return false;

  DynamicJsonDocument doc(512);
  if (deserializeJson(doc, body) == DeserializationError::Ok) {
    JsonArray arr = doc.as<JsonArray>();
    if (arr.size() > 0) {
      String lastDir = String(arr[0]["direction"] | "");
      String lastTs  = String(arr[0]["timestamp"] | "");
      if (lastDir == "ENTRY") {
        if (lastTs.length() >= 16) {
          conflictDetail = "IN: " + lastTs.substring(11, 16) + " " + lastTs.substring(5, 10);
        } else {
          conflictDetail = "IN: " + lastTs;
        }
        return true;
      }
    }
  }
  return false;
}

// =======================
// PROCESS SCAN (Online & Offline Smart Routing)
// =======================
void processScan(String uid) {
  Serial.println("[SCAN] UID: " + uid);
  lcdMsg("CHECKING...", uid.substring(0, 16));

  bool authorized = false;

  // 1. ONLINE MODE
  if (wifiConnected) {
    authorized = checkAuthorizationOnline(uid);

    if (!card_found) {
      Serial.println("[RESULT] NOT REGISTERED (Cloud)");
      lcdMsg("ACCESS DENIED", "UNREGISTERED");
      tone(BUZZER_PIN, 500, 400);
      blinkLED(RED_LED, 4);
      insertTransactionOnline(uid, "DENIED", "Unregistered RFID");
      delay(3000);
      showReady();
      return;
    }

    if (!authorized) {
      Serial.println("[RESULT] UNAUTHORIZED (Cloud)");
      lcdMsg("UNAUTHORIZED", "PENDING APPROVAL");
      tone(BUZZER_PIN, 500, 400);
      blinkLED(RED_LED, 3);
      insertTransactionOnline(uid, "DENIED", "Card not authorized");
      delay(3000);
      showReady();
      return;
    }

    // Check Duplicate Entry
    String conflictDetail = "";
    if (checkDuplicateEntryOnline(uid, conflictDetail)) {
      Serial.println("[RESULT] DUPLICATE ENTRY: " + conflictDetail);
      lcdMsg("ALREADY GRANTED", conflictDetail);
      tone(BUZZER_PIN, 1200, 200);
      delay(100);
      tone(BUZZER_PIN, 1200, 200);
      blinkLED(RED_LED, 2);

      insertTransactionOnline(uid, "PENDING_CONFIRMATION", "Duplicate entry - already inside (" + conflictDetail + ")");
      delay(4000);
      showReady();
      return;
    }

    // AUTHORIZED (Online)
    Serial.println("[RESULT] AUTHORIZED ENTRY (Cloud) — " + card_name);
    String plateLine = (card_plate.length() > 0) ? card_plate : uid.substring(0, 16);

    lcdMsg("ENTRY GRANTED", plateLine);
    tone(BUZZER_PIN, 2000, 150);
    delay(80);
    tone(BUZZER_PIN, 2500, 150);
    digitalWrite(RED_LED, LOW);
    digitalWrite(GREEN_LED, HIGH);

    String remarks = "ENTRY gate scan (Online)";
    if (card_role == "EMERGENCY") {
      remarks = "Emergency tag: " + (card_name.length() > 0 ? card_name : "Emergency Response");
    } else if (card_role == "VISITOR") {
      remarks = "Visitor Entry: " + (card_name.length() > 0 ? card_name : "Visitor") + " | Plate: " + card_plate;
    }

    insertTransactionOnline(uid, "AUTHORIZED", remarks);

    if (card_name.length() > 0) {
      lcd.setCursor(0, 1);
      lcd.print(card_name.substring(0, 16));
    }

    delay(4000);
    showReady();
    return;
  }

  // 2. OFFLINE MODE (SD Card Fallback)
  Serial.println("[OFFLINE MODE] Checking SD Card whitelist...");
  authorized = checkAuthorizationOffline(uid);

  if (authorized) {
    Serial.println("[RESULT] AUTHORIZED ENTRY (SD Card) — " + card_name);
    String plateLine = (card_plate.length() > 0) ? card_plate : uid.substring(0, 16);

    lcdMsg("[OFFLINE] PASS", plateLine);
    tone(BUZZER_PIN, 2000, 150);
    delay(80);
    tone(BUZZER_PIN, 2500, 150);
    digitalWrite(RED_LED, LOW);
    digitalWrite(GREEN_LED, HIGH);

    saveOfflineTransaction(uid, "AUTHORIZED", "Offline Entry Scan");

    if (card_name.length() > 0) {
      lcd.setCursor(0, 1);
      lcd.print(card_name.substring(0, 16));
    }
  } else {
    Serial.println("[RESULT] ACCESS DENIED (SD Card Whitelist)");
    lcdMsg("[OFFLINE] DENY", "UNREGISTERED");
    tone(BUZZER_PIN, 500, 400);
    blinkLED(RED_LED, 3);

    saveOfflineTransaction(uid, "DENIED", "Offline Unregistered RFID");
  }

  delay(4000);
  showReady();
}

// =======================
// BLE PROVISIONING CALLBACKS
// =======================
class BleServerCallbacks : public BLEServerCallbacks {
  void onConnect(BLEServer* pServer) {
    bleClientConnected = true;
    Serial.println("\n[BLE] Admin/Phone Connected via Bluetooth!");
    lcdMsg("BLUETOOTH PAIRED", "RECEIVING WIFI...");
    tone(BUZZER_PIN, 2000, 100);
  }

  void onDisconnect(BLEServer* pServer) {
    bleClientConnected = false;
    Serial.println("[BLE] Bluetooth Client Disconnected.");
    if (bleServerRunning) {
      BLEDevice::startAdvertising();
      showReady();
    }
  }
};

class BleCharCallbacks : public BLECharacteristicCallbacks {
  void handlePayload(String rxValue) {
    rxValue.trim();
    if (rxValue.length() == 0) return;

    Serial.println("\n[BLE] Received payload (" + String(rxValue.length()) + " bytes)...");
    String newSsid = "";
    String newPass = "";

    // 1. Parse JSON first
    DynamicJsonDocument doc(512);
    DeserializationError err = deserializeJson(doc, rxValue);
    if (!err) {
      if (doc.containsKey("ssid")) newSsid = doc["ssid"].as<String>();
      if (doc.containsKey("pass")) newPass = doc["pass"].as<String>();
    }

    // 2. Fallback to delimited: "SSID:PASS" or "SSID,PASS" or "WIFI:SSID,PASS"
    if (newSsid.length() == 0) {
      String clean = rxValue;
      if (clean.startsWith("WIFI:") || clean.startsWith("wifi:")) {
        clean = clean.substring(5);
      }
      int sep = clean.indexOf(':');
      if (sep == -1) sep = clean.indexOf(',');
      if (sep == -1) sep = clean.indexOf('\t');
      if (sep > 0) {
        newSsid = clean.substring(0, sep);
        newPass = clean.substring(sep + 1);
      } else {
        newSsid = clean;
      }
    }

    newSsid.trim();
    newPass.trim();

    if (newSsid.length() > 0) {
      currentSsid = newSsid;
      currentPass = newPass;

      Serial.println("[BLE] Parsed SSID: '" + currentSsid + "'");
      Serial.println("[BLE] Parsed Pass: [" + String(currentPass.length()) + " characters]");
      lcdMsg("SAVING WIFI...", currentSsid.substring(0, 16));
      tone(BUZZER_PIN, 2200, 200);

      // Save IMMEDIATELY to NVS Flash and SD Card so credentials are never lost
      saveWifiToNVS(currentSsid, currentPass);
      saveWifiToSD(currentSsid, currentPass);

      // Notify the BLE client that credentials are saved
      if (pBleCharacteristic && bleClientConnected) {
        String resp = "{\"event\":\"SAVED\",\"ssid\":\"" + currentSsid + "\"}";
        pBleCharacteristic->setValue(resp.c_str());
        pBleCharacteristic->notify();
      }

      newWifiCredentialsReceived = true;
    } else {
      Serial.println("[BLE ERROR] Could not extract SSID from payload: " + rxValue);
    }
  }

  void onWrite(BLECharacteristic* pCharacteristic) override {
    String val = pCharacteristic->getValue().c_str();
    if (val.length() == 0) {
      uint8_t* data = pCharacteristic->getData();
      size_t len = pCharacteristic->getLength();
      if (data && len > 0) {
        for (size_t i = 0; i < len; i++) val += (char)data[i];
      }
    }
    handlePayload(val);
  }
};

void sendDeviceHeartbeat() {
  if (WiFi.status() != WL_CONNECTED) return;
  HTTPClient http;
  String url = String(SUPABASE_URL) + "/rest/v1/devices?esp32_identifier=eq." + String(GATE_ID);
  http.begin(url);
  http.addHeader("apikey", SUPABASE_ANON);
  http.addHeader("Authorization", String("Bearer ") + SUPABASE_ANON);
  http.addHeader("Content-Type", "application/json");

  String payload = "{\"status\":\"ONLINE\",\"last_online\":\"now()\"}";
  int code = http.PATCH(payload);
  if (code < 200 || code >= 300) {
    http.end();
    String upsertUrl = String(SUPABASE_URL) + "/rest/v1/devices";
    http.begin(upsertUrl);
    http.addHeader("apikey", SUPABASE_ANON);
    http.addHeader("Authorization", String("Bearer ") + SUPABASE_ANON);
    http.addHeader("Content-Type", "application/json");
    http.addHeader("Prefer", "resolution=merge-duplicates");
    String fullPayload = "{\"esp32_identifier\":\"" + String(GATE_ID) + 
                         "\",\"device_name\":\"CHARRMPASS " + String(GATE_TYPE) + " Unit" + 
                         "\",\"gate_type\":\"" + String(GATE_TYPE) + 
                         "\",\"device_category\":\"VEHICLE_BARRIER\"" + 
                         ",\"device_location\":\"" + String(GATE_TYPE) + " Gate\"" + 
                         ",\"status\":\"ONLINE\",\"last_online\":\"now()\"}";
    http.POST(fullPayload);
  }
  http.end();
}

void startBleServer() {
  if (bleServerRunning) return;

  Serial.println("[BLE] Initializing Bluetooth Provisioning Server...");

  BLEDevice::init(BLE_DEVICE_NAME);
  BLEDevice::setMTU(517); // Support large MTU transfers from Web Bluetooth
  pBleServer = BLEDevice::createServer();
  pBleServer->setCallbacks(new BleServerCallbacks());

  BLEService* pService = pBleServer->createService(BLE_SERVICE_UUID);
  pBleCharacteristic = pService->createCharacteristic(
      BLE_CHAR_UUID,
      BLECharacteristic::PROPERTY_READ |
      BLECharacteristic::PROPERTY_WRITE |
      BLECharacteristic::PROPERTY_WRITE_NR |
      BLECharacteristic::PROPERTY_NOTIFY
  );

  pBleCharacteristic->setCallbacks(new BleCharCallbacks());
  pBleCharacteristic->addDescriptor(new BLE2902());
  pService->start();

  BLEAdvertising* pAdvertising = BLEDevice::getAdvertising();
  pAdvertising->addServiceUUID(BLE_SERVICE_UUID);
  pAdvertising->setScanResponse(true);
  pAdvertising->setMinPreferred(0x06);
  pAdvertising->setMinPreferred(0x12);

  BLEAdvertisementData oAdvertisementData = BLEAdvertisementData();
  oAdvertisementData.setFlags(0x04);
  oAdvertisementData.setCompleteServices(BLEUUID(BLE_SERVICE_UUID));
  oAdvertisementData.setName(BLE_DEVICE_NAME);
  pAdvertising->setAdvertisementData(oAdvertisementData);

  BLEAdvertisementData oScanResponseData = BLEAdvertisementData();
  oScanResponseData.setName(BLE_DEVICE_NAME);
  pAdvertising->setScanResponseData(oScanResponseData);

  BLEDevice::startAdvertising();
  bleServerRunning = true;
  Serial.println("[BLE] >>> BROADCASTING AS '" + String(BLE_DEVICE_NAME) + "' (Ready for Pairing) <<<");
}

// =======================
// SD CARD: SAVE Wi-Fi BACKUP
// =======================
void saveWifiToSD(String ssid, String pass) {
  if (!sdCardReady) return;
  if (!SD.exists("/config")) SD.mkdir("/config");
  File f = SD.open(WIFI_CONFIG_FILE, FILE_WRITE);
  if (f) {
    f.println("SSID=" + ssid);
    f.println("PASSWORD=" + pass);
    f.close();
    Serial.println("[SD] Wi-Fi backup saved to " + String(WIFI_CONFIG_FILE));
  } else {
    Serial.println("[SD] Could not write Wi-Fi backup to SD");
  }
}

// =======================
// SD CARD: LOAD Wi-Fi BACKUP
// =======================
bool loadWifiFromSD(String &outSsid, String &outPass) {
  if (!sdCardReady || !SD.exists(WIFI_CONFIG_FILE)) return false;
  File f = SD.open(WIFI_CONFIG_FILE, FILE_READ);
  if (!f) return false;
  outSsid = ""; outPass = "";
  while (f.available()) {
    String line = f.readStringUntil('\n');
    line.trim();
    if (line.startsWith("SSID=")) {
      outSsid = line.substring(5);
    } else if (line.startsWith("PASSWORD=")) {
      outPass = line.substring(9);
    }
  }
  f.close();
  if (outSsid.length() > 0) {
    Serial.println("[SD] Wi-Fi backup found. SSID: '" + outSsid + "'");
    return true;
  }
  return false;
}

// =======================
// NVS: SAVE Wi-Fi CREDENTIALS
// =======================
void saveWifiToNVS(String ssid, String pass) {
  preferences.begin("charrm_wifi", false);
  preferences.putString("ssid", ssid);
  preferences.putString("pass", pass);
  preferences.end();
  Serial.println("[NVS] Wi-Fi credentials saved. SSID: '" + ssid + "'");
}

// =======================
// DIAGNOSTIC 2.4GHz WI-FI SCANNER
// =======================
void scanAndPrintNetworks() {
  Serial.println("\n[WIFI SCAN] Scanning for nearby 2.4GHz Wi-Fi networks...");
  int n = WiFi.scanNetworks(false, true);
  if (n <= 0) {
    Serial.println("[WIFI SCAN] No networks found. (Make sure router is broadcasting on 2.4GHz)");
  } else {
    Serial.println("[WIFI SCAN] Discovered " + String(n) + " network(s):");
    for (int i = 0; i < n; ++i) {
      String sec = (WiFi.encryptionType(i) == WIFI_AUTH_OPEN) ? "OPEN" : "SECURED";
      Serial.println("   [" + String(i + 1) + "] \"" + WiFi.SSID(i) + "\" | RSSI: " + String(WiFi.RSSI(i)) + " dBm | " + sec);
    }
  }
  Serial.println();
}

// =======================
// WIFI CONNECTION & AUTO RECONNECT
// =======================
bool attemptWifiConnection(String testSsid, String testPass, int timeoutSeconds = 20) {
  if (testSsid.length() == 0) return false;

  Serial.println("\n===========================================");
  Serial.println("[WIFI] Target SSID: '" + testSsid + "'");
  if (testPass.length() > 0) {
    Serial.println("[WIFI] Password:    [" + String(testPass.length()) + " characters]");
  } else {
    Serial.println("[WIFI] Password:    (NONE / OPEN NETWORK)");
  }
  Serial.println("===========================================");
  lcdMsg("CONNECTING WiFi", testSsid.substring(0, 16));

  // Pause BLE advertising while connecting to prevent 2.4GHz radio collisions
  if (bleServerRunning && BLEDevice::getAdvertising()) {
    BLEDevice::stopAdvertising();
    delay(100);
  }

  // Proper WiFi initialization — DO NOT use WiFi.disconnect(true) which powers off radio!
  WiFi.mode(WIFI_STA);
  WiFi.disconnect();
  delay(150);

  WiFi.setAutoReconnect(true);

  if (testPass.length() > 0) {
    WiFi.begin(testSsid.c_str(), testPass.c_str());
  } else {
    WiFi.begin(testSsid.c_str(), NULL);
  }

  Serial.print("[WIFI] Connecting to '" + testSsid + "'");
  int elapsed = 0;
  while (WiFi.status() != WL_CONNECTED && elapsed < timeoutSeconds * 2) {
    delay(500);
    Serial.print(".");
    elapsed++;

    if (WiFi.status() == WL_CONNECT_FAILED) {
      Serial.println("\n[WIFI ERROR] WL_CONNECT_FAILED (Code 4): Password was rejected by the router!");
      break;
    }
  }

  if (WiFi.status() == WL_CONNECTED) {
    wifiConnected = true;
    WiFi.setSleep(false); // Disable WiFi modem sleep only AFTER successful connection
    Serial.println("\n[OK] WiFi Connected! IP: " + WiFi.localIP().toString() + " | RSSI: " + String(WiFi.RSSI()) + " dBm");
    lcdMsg("WiFi CONNECTED", WiFi.localIP().toString());
    delay(1000);

    saveWifiToNVS(testSsid, testPass);
    saveWifiToSD(testSsid, testPass);
    currentSsid = testSsid;
    currentPass = testPass;

    // Notify BLE client of success
    if (pBleCharacteristic && bleClientConnected) {
      String notifyMsg = "{\"event\":\"CONNECTED\",\"ssid\":\"" + testSsid + "\",\"ip\":\"" + WiFi.localIP().toString() + "\",\"rssi\":" + String(WiFi.RSSI()) + "}";
      pBleCharacteristic->setValue(notifyMsg.c_str());
      pBleCharacteristic->notify();
    }

    syncWhitelistToSD();
    syncOfflineTransactionsToCloud();
    sendDeviceHeartbeat();
    Serial.println("[WIFI] Stable connection established.");

  } else {
    wifiConnected = false;
    int st = WiFi.status();
    Serial.println("\n[WARN] WiFi connection failed (Status: " + String(st) + ")");
    if (st == WL_NO_SSID_AVAIL) {
      Serial.println("       Reason: WL_NO_SSID_AVAIL (1) — SSID '" + testSsid + "' not found! Check spelling and ensure 2.4GHz is enabled.");
    } else if (st == WL_CONNECT_FAILED) {
      Serial.println("       Reason: WL_CONNECT_FAILED (4) — Incorrect password.");
    } else if (st == WL_DISCONNECTED) {
      Serial.println("       Reason: WL_DISCONNECTED (6) — Handshake timeout or radio contention.");
    }
    Serial.println("[WARN] WiFi not connected. Bluetooth provisioning remains active.");
    lcdMsg("WIFI FAILED", "Check SSID/Pass");

    // Scan and list nearby 2.4GHz networks for diagnostics
    scanAndPrintNetworks();

    if (pBleCharacteristic && bleClientConnected) {
      String errMsg = (st == WL_NO_SSID_AVAIL) ? "SSID not found on 2.4GHz" : ((st == WL_CONNECT_FAILED) ? "Incorrect password" : "Connection failed");
      String notifyMsg = "{\"event\":\"FAILED\",\"error\":\"" + errMsg + "\",\"code\":" + String(st) + "}";
      pBleCharacteristic->setValue(notifyMsg.c_str());
      pBleCharacteristic->notify();
    }

    // Resume BLE advertising so user can re-provision
    if (bleServerRunning && BLEDevice::getAdvertising()) {
      BLEDevice::startAdvertising();
      Serial.println("[BLE] Advertising resumed for re-provisioning.");
    }

    delay(1000);
  }

  return wifiConnected;
}

// =======================
// SETUP
// =======================
void setup() {
  Serial.begin(115200);
  delay(500); // Allow UART, USB-to-Serial bridge, and power rail to stabilize
  Serial.println("\n===========================================");
  Serial.println("  CHARRMPASS — ENTRY GATE (DUAL SPI BUS)");
  Serial.println("===========================================\n");
  Serial.flush();

  Serial.println("[BOOT] Initializing I2C bus and LCD...");
  Wire.begin(21, 22);
  lcd.begin(16, 2);
  lcdMsg("  CHARRMPASS  ", "ENTRY GATE");
  delay(1000);

  // 1. Initialize RFID on VSPI (Default SPI: SCK 18, MISO 19, MOSI 23, SS 5)
  SPI.begin();
  rfid.PCD_Init();
  rfid.PCD_SetAntennaGain(MFRC522::RxGain_max);
  Serial.println("[RFID] Initialized on VSPI (SS 5, SCK 18, MISO 19, MOSI 23)");

  // 2. Initialize SD Card on dedicated HSPI Bus (SCK 26, MISO 14, MOSI 12, CS 13)
  initSDCard();

  pinMode(RED_LED, OUTPUT);
  pinMode(GREEN_LED, OUTPUT);
  pinMode(BUZZER_PIN, OUTPUT);
  digitalWrite(RED_LED, HIGH);
  digitalWrite(GREEN_LED, LOW);

  // 3. Load Saved Wi-Fi Credentials
  // Priority 1: NVS Flash
  preferences.begin("charrm_wifi", true);
  currentSsid = preferences.getString("ssid", "");
  currentPass = preferences.getString("pass", "");
  preferences.end();

  // Priority 2: SD Card Backup (/config/wifi.cfg) if NVS is empty
  if (currentSsid.length() == 0) {
    if (loadWifiFromSD(currentSsid, currentPass)) {
      Serial.println("[BOOT] Loaded Wi-Fi credentials from SD backup: '" + currentSsid + "'");
    }
  }

  if (currentSsid.length() > 0) {
    // 4a. Credentials found (NVS or SD) — attempt WiFi FIRST (BLE paused to avoid radio contention)
    Serial.println("[BOOT] Wi-Fi credentials found: '" + currentSsid + "'. Attempting connection...");
    bool wifiOk = attemptWifiConnection(currentSsid, currentPass, 15);
    if (!wifiOk) {
      // WiFi failed — start BLE for re-provisioning
      Serial.println("[BOOT] Wi-Fi connection failed. Starting BLE for re-provisioning.");
      startBleServer();
    }
    // If WiFi succeeded, attemptWifiConnection automatically saves to NVS and SD backup!
  } else {
    // 4b. No credentials found anywhere — open BLE for initial provisioning
    Serial.println("[BOOT] No saved Wi-Fi credentials found in NVS or SD. Starting BLE setup mode.");
    lcdMsg("[NO WIFI SAVED]", "BLE SETUP MODE");
    scanAndPrintNetworks();
    startBleServer();
  }

  showReady();
}

// =======================
// MAIN LOOP
// =======================
void loop() {
  // If new Wi-Fi credentials were sent from Web Bluetooth, connect now!
  if (newWifiCredentialsReceived) {
    newWifiCredentialsReceived = false;
    Serial.println("\n[PROVISION] Credentials saved to NVS Flash and SD Card!");
    Serial.println("[PROVISION] Restarting ESP32 to connect cleanly with dedicated radio & RAM...");
    lcdMsg("WIFI SAVED!", "RESTARTING...");
    tone(BUZZER_PIN, 2000, 100);
    delay(100);
    tone(BUZZER_PIN, 2500, 150);
    delay(800); // Allow BLE notification to finish sending to browser
    ESP.restart();
  }

  // WiFi Watchdog & Reconnection Handling
  if (WiFi.status() != WL_CONNECTED) {
    if (wifiConnected) {
      wifiConnected = false;
      Serial.println("[WARN] WiFi lost — SD Fallback Mode Active");
      showReady();
    }
  } else {
    if (!wifiConnected) {
      wifiConnected = true;
      Serial.println("[OK] WiFi Reconnected! Syncing offline data...");
      syncOfflineTransactionsToCloud();
      syncWhitelistToSD();
      sendDeviceHeartbeat();
      showReady();
    }
  }

  // Periodic Heartbeat to Supabase (Every 60 seconds)
  static unsigned long lastHeartbeat = 0;
  if (wifiConnected && (millis() - lastHeartbeat > 60000)) {
    lastHeartbeat = millis();
    sendDeviceHeartbeat();
  }

  // Periodic Whitelist Sync when Online
  if (wifiConnected && (millis() - lastWhitelistSync > WHITELIST_SYNC_INTERVAL)) {
    syncWhitelistToSD();
  }

  // 1. Guard Manual Serial Input & Configuration
  if (Serial.available() > 0) {
    String inputStr = Serial.readStringUntil('\n');
    inputStr.trim();
    if (inputStr.length() > 0) {

      // ── WIFI:<SSID>,<PASS>  → Save credentials and reconnect ──
      if (inputStr.startsWith("WIFI:") || inputStr.startsWith("wifi:")) {
        String payload = inputStr.substring(5);
        int comma = payload.indexOf(',');
        if (comma != -1) {
          currentSsid = payload.substring(0, comma);
          currentPass = payload.substring(comma + 1);
        } else {
          currentSsid = payload;
          currentPass = "";
        }
        currentSsid.trim();
        currentPass.trim();

        Serial.println("\n[SERIAL PROVISION] Saving credentials for SSID: '" + currentSsid + "'...");
        saveWifiToNVS(currentSsid, currentPass);
        saveWifiToSD(currentSsid, currentPass);
        lcdMsg("SAVED! RESTART", currentSsid.substring(0, 16));
        tone(BUZZER_PIN, 2200, 300);
        delay(600);
        ESP.restart();
        return;
      }

      // ── RESET: → Wipe NVS credentials and SD backup, then re-enter BLE provisioning mode ──
      if (inputStr.equalsIgnoreCase("RESET:") || inputStr.equalsIgnoreCase("RESET")) {
        preferences.begin("charrm_wifi", false);
        preferences.remove("ssid");
        preferences.remove("pass");
        preferences.end();
        if (sdCardReady && SD.exists(WIFI_CONFIG_FILE)) {
          SD.remove(WIFI_CONFIG_FILE);
          Serial.println("[RESET] SD Wi-Fi backup removed.");
        }
        currentSsid = "";
        currentPass = "";
        Serial.println("[RESET] Wi-Fi credentials cleared from NVS & SD. Restarting BLE provisioning...");
        lcdMsg("WIFI RESET", "BLE SETUP MODE");
        tone(BUZZER_PIN, 500, 400);
        delay(500);
        WiFi.disconnect(true);
        wifiConnected = false;
        startBleServer();
        showReady();
        return;
      }

      // ── Manual RFID UID entry ──
      String manualUid = inputStr;
      manualUid.toUpperCase();
      Serial.println("\n[MANUAL ENCODE] Guard entered UID: " + manualUid);
      tone(BUZZER_PIN, 1800, 100);
      processScan(manualUid);
      return;
    }
  }

  // 2. Physical Card Scan
  if (!rfid.PICC_IsNewCardPresent()) return;
  if (!rfid.PICC_ReadCardSerial()) return;

  if (millis() - lastScanTime < SCAN_COOLDOWN) {
    rfid.PICC_HaltA();
    return;
  }
  lastScanTime = millis();

  String uid = "";
  for (byte i = 0; i < rfid.uid.size; i++) {
    if (rfid.uid.uidByte[i] < 0x10) uid += "0";
    uid += String(rfid.uid.uidByte[i], HEX);
    if (i != rfid.uid.size - 1) uid += " ";
  }
  uid.toUpperCase();

  tone(BUZZER_PIN, 2000, 100);
  processScan(uid);
  rfid.PICC_HaltA();
}
