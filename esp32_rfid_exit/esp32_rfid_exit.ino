/*
 * ============================================================
 * CHARRMPASS — ESP32 EXIT Gate RFID Scanner v3.6 (Dual Hardware SPI)
 *
 * Dedicated firmware for the EXIT GATE unit with independent SPI buses:
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

#define GATE_TYPE "EXIT"
#define GATE_ID "CHARRMPASS_GATE_EXIT"

#include <ArduinoJson.h>
#include <FS.h>
#include <HTTPClient.h>
#include <MFRC522.h>
#include <SD.h>
#include <SPI.h>
#include <WiFi.h>
#include <Wire.h>
#include <hd44780.h>
#include <hd44780ioClass/hd44780_I2Cexp.h>

// =======================
// WIFI SETTINGS
// =======================
const char *ssid = "FTTx-4a6210";  // <-- replace with your WiFi name
const char *password = "10008636"; // <-- replace with your WiFi password

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

// =======================
// SD CARD & SCAN STATE
// =======================
bool sdCardReady = false;
const char *WHITELIST_FILE = "/authorized_cards.csv";
const char *OFFLINE_TXNS_FILE = "/offline_txns.csv";

bool card_found = false;
bool card_authorized = false;
String card_name = "";
String card_plate = "";
String card_role = "";
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
    lcdMsg("  SCAN CARD   ", "EXIT READY...");
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

  // Check special_tags first (Visitor / Emergency)
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

  // Check registered users
  String url = String(SUPABASE_URL) + "/rest/v1/rfid_cards?rfid_uid=eq." +
               urlEncode(uid) +
               "&select=authorization_status,vehicle_id,user_id,"
               "vehicles(plate_number),"
               "users(full_name,role)";

  HTTPClient http;
  http.begin(url);
  http.addHeader("apikey", SUPABASE_ANON);
  http.addHeader("Authorization", String("Bearer ") + SUPABASE_ANON);

  int code = http.GET();
  String body = "";
  if (code == 200) body = http.getString();
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

  if (!card["vehicles"].isNull()) {
    card_plate = String(card["vehicles"]["plate_number"] | "");
  }
  if (!card["users"].isNull()) {
    card_name = String(card["users"]["full_name"] | "");
    card_role = String(card["users"]["role"] | "");
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
// RESET REUSABLE VISITOR TAG
// =======================
void resetVisitorTagOnline(String uid) {
  String url = String(SUPABASE_URL) + "/rest/v1/special_tags?rfid_uid=eq." + urlEncode(uid) + "&type=eq.VISITOR";
  HTTPClient http;
  http.begin(url);
  http.addHeader("Content-Type", "application/json");
  http.addHeader("apikey", SUPABASE_ANON);
  http.addHeader("Authorization", String("Bearer ") + SUPABASE_ANON);
  DynamicJsonDocument doc(256);
  doc["label"] = "Reusable Visitor Tag";
  doc["description"] = (char*)NULL;
  String body;
  serializeJson(doc, body);
  http.PATCH(body);
  http.end();
  Serial.println("[VISITOR] Tag " + uid + " reset to vacant/reusable state.");
}

// =======================
// ONLINE DOUBLE EXIT / PRIOR STATE CHECK
// =======================
bool checkExitConflictOnline(String uid, String &conflictMsg, String &conflictDetail) {
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

  if (body.length() == 0 || body == "[]") {
    conflictMsg = "NO ENTRY LOGGED";
    conflictDetail = "VERIFY W/ GUARD";
    return true;
  }

  DynamicJsonDocument doc(512);
  if (deserializeJson(doc, body) == DeserializationError::Ok) {
    JsonArray arr = doc.as<JsonArray>();
    if (arr.size() > 0) {
      String lastDir = String(arr[0]["direction"] | "");
      String lastTs  = String(arr[0]["timestamp"] | "");
      String timeStr = "";
      if (lastTs.length() >= 16) {
        timeStr = lastTs.substring(11, 16) + " " + lastTs.substring(5, 10);
      } else {
        timeStr = lastTs;
      }

      if (lastDir == "EXIT") {
        conflictMsg = "ALREADY EXITED";
        conflictDetail = "OUT: " + timeStr;
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

    // Check Exit State Conflict
    String conflictMsg = "";
    String conflictDetail = "";
    if (checkExitConflictOnline(uid, conflictMsg, conflictDetail)) {
      Serial.println("[RESULT] EXIT CONFLICT: " + conflictMsg + " - " + conflictDetail);
      lcdMsg(conflictMsg, conflictDetail);
      tone(BUZZER_PIN, 1200, 200);
      delay(100);
      tone(BUZZER_PIN, 1200, 200);
      blinkLED(RED_LED, 2);

      insertTransactionOnline(uid, "PENDING_CONFIRMATION", "EXIT conflict: " + conflictMsg + " (" + conflictDetail + ")");
      delay(4000);
      showReady();
      return;
    }

    // AUTHORIZED EXIT (Online)
    Serial.println("[RESULT] AUTHORIZED EXIT (Cloud) — " + card_name);
    String plateLine = (card_plate.length() > 0) ? card_plate : uid.substring(0, 16);

    lcdMsg("EXIT GRANTED", plateLine);
    tone(BUZZER_PIN, 2000, 150);
    delay(80);
    tone(BUZZER_PIN, 2500, 150);
    digitalWrite(RED_LED, LOW);
    digitalWrite(GREEN_LED, HIGH);

    String remarks = "EXIT gate scan (Online)";
    if (card_role == "EMERGENCY") {
      remarks = "Emergency tag: " + (card_name.length() > 0 ? card_name : "Emergency Response");
    } else if (card_role == "VISITOR") {
      remarks = "Visitor Exit: " + (card_name.length() > 0 ? card_name : "Visitor") + " | Plate: " + card_plate;
      resetVisitorTagOnline(uid);
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
    Serial.println("[RESULT] AUTHORIZED EXIT (SD Card) — " + card_name);
    String plateLine = (card_plate.length() > 0) ? card_plate : uid.substring(0, 16);

    lcdMsg("[OFFLINE] PASS", plateLine);
    tone(BUZZER_PIN, 2000, 150);
    delay(80);
    tone(BUZZER_PIN, 2500, 150);
    digitalWrite(RED_LED, LOW);
    digitalWrite(GREEN_LED, HIGH);

    saveOfflineTransaction(uid, "AUTHORIZED", "Offline Exit Scan");

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
// WIFI CONNECTION & AUTO RECONNECT
// =======================
void connectWiFi() {
  lcdMsg("CONNECTING WiFi", "Please wait...");
  WiFi.begin(ssid, password);
  int tries = 0;
  while (WiFi.status() != WL_CONNECTED && tries < 20) {
    delay(500);
    Serial.print(".");
    tries++;
  }
  if (WiFi.status() == WL_CONNECTED) {
    wifiConnected = true;
    Serial.println("\n[OK] WiFi: " + WiFi.localIP().toString());
    lcdMsg("WiFi CONNECTED", WiFi.localIP().toString());
    delay(1500);
    syncWhitelistToSD();
    syncOfflineTransactionsToCloud();
  } else {
    wifiConnected = false;
    Serial.println("\n[WARN] WiFi FAILED — Operating in SD Card Offline Mode");
    lcdMsg("OFFLINE MODE", "SD Fallback Ready");
    delay(2000);
  }
}

// =======================
// SETUP
// =======================
void setup() {
  Serial.begin(115200);
  Serial.println("\n==========================================");
  Serial.println("  CHARRMPASS — EXIT GATE (DUAL SPI BUS)");
  Serial.println("==========================================\n");

  Wire.begin(21, 22);
  lcd.begin(16, 2);
  lcdMsg("  CHARRMPASS  ", "EXIT GATE");
  delay(1500);

  // 1. Initialize RFID on VSPI (Default SPI: SCK 18, MISO 19, MOSI 23, SS 5)
  SPI.begin();
  rfid.PCD_Init();
  rfid.PCD_SetAntennaGain(MFRC522::RxGain_max); // Maximize scan range
  Serial.println("[RFID] Initialized on VSPI (SS 5, SCK 18, MISO 19, MOSI 23)");

  // 2. Initialize SD Card on dedicated HSPI Bus (SCK 26, MISO 14, MOSI 12, CS 13)
  initSDCard();

  pinMode(RED_LED, OUTPUT);
  pinMode(GREEN_LED, OUTPUT);
  pinMode(BUZZER_PIN, OUTPUT);
  digitalWrite(RED_LED, HIGH);
  digitalWrite(GREEN_LED, LOW);

  connectWiFi();
  showReady();
}

// =======================
// MAIN LOOP
// =======================
void loop() {
  // WiFi Watchdog & Reconnection Handling
  if (WiFi.status() != WL_CONNECTED) {
    if (wifiConnected) {
      wifiConnected = false;
      Serial.println("[WARN] WiFi lost — Switched to SD Card Offline Mode");
      showReady();
    }
  } else {
    if (!wifiConnected) {
      wifiConnected = true;
      Serial.println("[OK] WiFi Reconnected! Syncing offline data...");
      syncOfflineTransactionsToCloud();
      syncWhitelistToSD();
      showReady();
    }
  }

  // Periodic Whitelist Sync when Online
  if (wifiConnected && (millis() - lastWhitelistSync > WHITELIST_SYNC_INTERVAL)) {
    syncWhitelistToSD();
  }

  // 1. Guard Manual Serial Input
  if (Serial.available() > 0) {
    String manualUid = Serial.readStringUntil('\n');
    manualUid.trim();
    manualUid.toUpperCase();
    if (manualUid.length() > 0) {
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
