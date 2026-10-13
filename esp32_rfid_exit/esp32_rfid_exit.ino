/*
 * ============================================================
 * CHARRMPASS — CLOSE-RANGE RFID PEDESTRIAN EXIT GATE
 *
 * Dedicated Firmware for the PEDESTRIAN EXIT TURNSTILE:
 *   - Operating Frequency: 13.56 MHz HF (MFRC522 / MIFARE / ISO 14443A)
 *   - Role: Dedicated Pedestrian Exit Turnstile (Separate Hardware Unit)
 *   - Dual Hardware SPI Buses:
 *       * VSPI Bus (Pins 18, 19, 23, 5): Dedicated to MFRC522 (13.56 MHz HF)
 *       * HSPI Bus (Pins 26, 14, 12, 13): Dedicated to MicroSD Card Module
 *
 * Features:
 *   - Sub-50ms local verification using high-speed RAM & SD Card cache
 *   - Traffic Light System: RED = Standby, YELLOW = Scanning, GREEN = Done
 *   - Reliable Offline Fallback: Logs offline scans to SD card
 * (/offline_txns.csv)
 *   - Over-The-Air (OTA) Cloud Wi-Fi Control via Supabase
 *
 * Hardware Wiring:
 *   - MFRC522 RFID Reader (VSPI - 13.56 MHz HF):
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
 *   - Traffic Light LEDs: RED (GPIO 2), YELLOW (GPIO 25), GREEN (GPIO 4)
 *   - Active Buzzer: GPIO 15
 * ============================================================
 */

#define GATE_TYPE "EXIT"
#define GATE_ID "CHARRMPASS_GATE_EXIT"
#define GATE_NAME "CHARRMPASS Exit Unit"
#define GATE_CATEGORY "PEDESTRIAN (EXIT)"
#define GATE_LOCATION "Pedestrian Exit Gate"
#define RFID_FREQUENCY "13.56 MHz HF"

#include "soc/rtc_cntl_reg.h"
#include "soc/soc.h"
#include <ArduinoJson.h>
#include <FS.h>
#include <HTTPClient.h>
#include <MFRC522.h>
#include <Preferences.h>
#include <SD.h>
#include <SPI.h>
#include <WiFi.h>
#include <WiFiClientSecure.h>
#include <Wire.h>
#include <esp_bt.h> // for esp_bt_controller_mem_release()
#include <esp_wifi.h>
#include <hd44780.h>
#include <hd44780ioClass/hd44780_I2Cexp.h>

// BLE Libraries for wireless Web Bluetooth provisioning
#include <BLE2902.h>
#include <BLEDevice.h>
#include <BLEServer.h>
#include <BLEUtils.h>

// BLE Service & Characteristic UUIDs (Matches CHARRMPASS Web App)
#define BLE_SERVICE_UUID "4fafc201-1fb5-459e-8fcc-c5c9c331914b"
#define BLE_CHAR_UUID "beb5483e-36e1-4688-b7f5-ea07361b26a8"
#define BLE_DEVICE_NAME "CHARRMPASS_EXIT_BLE"

// =======================
// WI-FI CREDENTIALS & SETTINGS
// Wi-Fi can be configured wirelessly via Web Bluetooth from the Admin
// Dashboard, Over-The-Air from cloud, or via MicroSD / Serial.
// =======================
const char *DEFAULT_WIFI_SSID = "YOUR_WIFI_SSID";
const char *DEFAULT_WIFI_PASS = "YOUR_WIFI_PASSWORD";

String currentSsid = "";
String currentPass = "";

// =======================
// SUPABASE SETTINGS
// =======================
const char *SUPABASE_URL = "https://xrdpgsnastqnbhvdltwt.supabase.co";
const char *SUPABASE_ANON =
    "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9."
    "eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InhyZHBnc25hc3RxbmJodmRsdHd0Iiwicm9sZSI6Im"
    "Fub24iLCJpYXQiOjE3OTEzMDQxMjgsImV4cCI6MjEwNjg4MDEyOH0.1ZKaUnEmB9B7"
    "PVk8arIhkGRqoxJbv6-VzflUaB7mZiE";

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

// 3. Peripherals (Traffic Light LED System)
#define RED_LED 2     // STANDBY: Card reader idle & waiting for tap
#define YELLOW_LED 25 // SCANNING: Reading card & verifying local authorization
#define GREEN_LED 4   // DONE: Authorized & exit gate passage granted
#define BUZZER_PIN 15
#define BOOT_BUTTON_PIN                                                        \
  0 // ESP32 onboard BOOT button (Hold 3s to enter BLE setup mode)

// Hardware Instances
MFRC522 rfid(RFID_SS_PIN, RFID_RST_PIN);
SPIClass spiSD(HSPI); // Independent HSPI Controller for SD
hd44780_I2Cexp lcd;
Preferences preferences;
WiFiClientSecure secureClient;

// BLE Server handles & wireless provisioning state
BLEServer *pBleServer = NULL;
BLECharacteristic *pBleCharacteristic = NULL;
bool bleClientConnected = false;
bool bleServerRunning = false;
volatile bool newWifiCredentialsReceived = false;
String pendingBleSsid = "";
String pendingBlePass = "";

// BLE callbacks run on the Bluetooth stack task. They only set flags; loop()
// handles LCD/buzzer.
volatile bool bleEvtConnected = false;
volatile bool bleEvtDisconnected = false;

// Coexistence: ESP32 shares ONE 2.4GHz radio between Wi-Fi and BLE.
// When BLE is active, WIFI_PS_MIN_MODEM is required by ESP-IDF to prevent
// panic.
void applyWifiPowerSave() {
  if (bleServerRunning) {
    esp_wifi_set_ps(WIFI_PS_MIN_MODEM);
  } else {
    esp_wifi_set_ps(WIFI_PS_NONE);
  }
}

// =======================
// ULTRA-FAST LOCAL CACHE (DYNAMIC HEAP RAM + SD HYBRID)
// =======================
struct WhitelistCard {
  char uid[18];
  char name[32];
  char plate[16];
  char role[16];
  char userType[14];
  char rfidType[14];
  char vehicleId[38];
  char userId[38];
};

#define MAX_RAM_CARDS 100
WhitelistCard *ramWhitelist = NULL;
int ramWhitelistCount = 0;

struct InsideRecord {
  char uid[18];
  unsigned long timestamp;
};

#define MAX_INSIDE_RECORDS 60
InsideRecord *ramInsideList = NULL;
int ramInsideCount = 0;

// Anti-Passback Exit Tracking (Instant sub-millisecond local duplicate exit
// suppression)
struct ExitRecord {
  char uid[18];
  unsigned long timestamp;
};
#define MAX_RECENT_EXITS 60
ExitRecord ramRecentExits[MAX_RECENT_EXITS];
int ramRecentExitsCount = 0;

// =======================
// ASYNCHRONOUS TRANSACTION QUEUE (NON-BLOCKING TURNSTILE THROUGHPUT)
// =======================
struct QueuedTransaction {
  char uid[18];
  char status[24];
  char remarks[80];
  char userType[14];
  char rfidType[14];
  char vehicleId[38];
  char userId[38];
  bool isVisitor;
};
#define MAX_TX_QUEUE 16
QueuedTransaction txQueue[MAX_TX_QUEUE];
int txQueueHead = 0;
int txQueueTail = 0;
int txQueueCount = 0;

// Non-blocking gate hold timer
unsigned long readyResetTime = 0;
bool isDisplayHolding = false;

// =======================
// SD CARD & SCAN STATE
// =======================
bool sdCardReady = false;
const char *WHITELIST_FILE = "/authorized_cards.csv";
const char *OFFLINE_TXNS_FILE = "/offline_txns.csv";
const char *WIFI_CONFIG_FILE = "/config/wifi.cfg"; // SD Wi-Fi backup

bool card_found = false;
bool card_authorized = false;
String card_name = "";
String card_plate = "";
String card_role = "";
String card_userType = "PEDESTRIAN";
String card_rfidType = "CLOSE_RANGE";
String card_vehicleId = "";
String card_userId = "";

unsigned long lastScanTime = 0;
const unsigned long SCAN_COOLDOWN = 800; // Ultra-fast 0.8s turnstile throughput
bool wifiConnected = false;
unsigned long lastWhitelistSync = 0;
const unsigned long WHITELIST_SYNC_INTERVAL = 300000; // 5 minutes

// Forward declarations
bool attemptWifiConnection(String testSsid, String testPass,
                           int timeoutSeconds = 20);
void syncWhitelistToSD();
void loadWhitelistFromSDToRAM();
void showReadyNonBlocking(unsigned long holdMs);
void insertTransactionOnline(String uid, String status, String remarks,
                             bool isVisitor = false);
void enqueueTransaction(String uid, String status, String remarks, String uType,
                        String rType, String vId, String uId,
                        bool isVisitor = false);
void processCloudQueue();
void sendTransactionToCloud(const QueuedTransaction &item);
bool checkAuthorizationFast(String uid);
void clearInsideFast(String uid);
void markInsideFast(String uid);
void markExitedLocal(String uid);
bool checkAlreadyExitedLocal(String uid, String &conflictDetail);
bool checkExitConflictOnline(String uid, String &conflictMsg,
                             String &conflictDetail);
void syncInsideStatusFromCloud();

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

void setTrafficLight(bool red, bool yellow, bool green) {
  digitalWrite(RED_LED, red ? HIGH : LOW);
  digitalWrite(YELLOW_LED, yellow ? HIGH : LOW);
  digitalWrite(GREEN_LED, green ? HIGH : LOW);
}

void signalWifiConnectedSuccess() {
  Serial.println("[WIFI] Connection Successful! 3 Green Blinks...");
  // Clear all lights first
  setTrafficLight(false, false, false);

  // Blink Green 3 times with confirmation tone
  for (int i = 0; i < 3; i++) {
    digitalWrite(GREEN_LED, HIGH);
    tone(BUZZER_PIN, 2400, 100);
    delay(150);
    digitalWrite(GREEN_LED, LOW);
    delay(150);
  }

  // Stop blinking and enter Standby: RED ON
  setTrafficLight(true, false, false);
}

void showReady() {
  if (wifiConnected && WiFi.status() == WL_CONNECTED) {
    lcdMsg("  SCAN CARD   ", "EXIT READY...");
    // Standby: Solid RED when Online
    setTrafficLight(true, false, false);
  } else {
    if (bleServerRunning) {
      lcdMsg("  SCAN CARD   ", "BLE ON: NO WIFI");
    } else {
      lcdMsg("  SCAN CARD   ", "[OFFLINE] READY");
    }
    // Standby: Blinking Yellow when Offline (Traffic Light initialized to
    // Yellow, pulsed non-blocking in loop)
    setTrafficLight(false, true, false);
  }
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

  Serial.print("[SD] Initializing SD Card on HSPI (CS 13, MOSI 12, MISO 14, "
               "SCK 26)... ");

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
    f.print(uid);
    f.print(",");
    f.print(GATE_TYPE);
    f.print(",");
    f.print(status);
    f.print(",");
    f.print(remarks);
    f.print(",");
    f.print(card_name.length() > 0 ? card_name : "Unknown");
    f.print(",");
    f.println(card_plate.length() > 0 ? card_plate : "--");
    f.close();
    Serial.println("[SD] Logged offline transaction for " + uid);
  }
}

// =======================
// SD CARD WHITELIST CACHE (Download & Store)
// =======================
// =======================
// SD & RAM WHITELIST CACHE (Download & Store)
// =======================
void loadWhitelistFromSDToRAM() {
  ramWhitelistCount = 0;
  if (!ramWhitelist || !sdCardReady || !SD.exists(WHITELIST_FILE)) {
    Serial.println("[RAM CACHE] Whitelist file not found on SD card.");
    lcdMsg("SD CACHE", "FILE NOT FOUND");
    delay(500);
    return;
  }

  lcdMsg("READING SD CACHE", "LOADING TO RAM..");

  File f = SD.open(WHITELIST_FILE, FILE_READ);
  if (!f)
    return;

  if (f.available()) {
    f.readStringUntil('\n'); // Skip CSV header
  }

  while (f.available() && ramWhitelistCount < MAX_RAM_CARDS) {
    String line = f.readStringUntil('\n');
    line.trim();
    if (line.length() == 0)
      continue;

    int c1 = line.indexOf(',');
    int c2 = line.indexOf(',', c1 + 1);
    int c3 = line.indexOf(',', c2 + 1);
    int c4 = line.indexOf(',', c3 + 1);
    int c5 = line.indexOf(',', c4 + 1);
    int c6 = line.indexOf(',', c5 + 1);
    int c7 = line.indexOf(',', c6 + 1);

    if (c1 > 0 && c2 > 0) {
      WhitelistCard &wc = ramWhitelist[ramWhitelistCount];
      memset(&wc, 0, sizeof(WhitelistCard));

      strncpy(wc.uid, line.substring(0, c1).c_str(), sizeof(wc.uid) - 1);
      strncpy(wc.name, line.substring(c1 + 1, c2).c_str(), sizeof(wc.name) - 1);
      strncpy(wc.plate,
              (c3 > 0 ? line.substring(c2 + 1, c3) : line.substring(c2 + 1))
                  .c_str(),
              sizeof(wc.plate) - 1);
      if (c3 > 0)
        strncpy(wc.role,
                (c4 > 0 ? line.substring(c3 + 1, c4) : line.substring(c3 + 1))
                    .c_str(),
                sizeof(wc.role) - 1);
      if (c4 > 0)
        strncpy(wc.userType,
                (c5 > 0 ? line.substring(c4 + 1, c5) : line.substring(c4 + 1))
                    .c_str(),
                sizeof(wc.userType) - 1);
      if (c5 > 0)
        strncpy(wc.rfidType,
                (c6 > 0 ? line.substring(c5 + 1, c6) : line.substring(c5 + 1))
                    .c_str(),
                sizeof(wc.rfidType) - 1);
      if (c6 > 0)
        strncpy(wc.vehicleId,
                (c7 > 0 ? line.substring(c6 + 1, c7) : line.substring(c6 + 1))
                    .c_str(),
                sizeof(wc.vehicleId) - 1);
      if (c7 > 0)
        strncpy(wc.userId, line.substring(c7 + 1).c_str(),
                sizeof(wc.userId) - 1);

      ramWhitelistCount++;
    }
  }
  f.close();
  Serial.println("[RAM CACHE] Loaded " + String(ramWhitelistCount) +
                 " cards from SD into fast RAM (EXIT).");
  lcdMsg("SD CACHE READY", String(ramWhitelistCount) + " CARDS IN RAM");
  delay(600);
}

void markInsideFast(String uid) {
  if (ramInsideList == NULL)
    return;
  String cleanUid = uid;
  cleanUid.replace(" ", "");
  cleanUid.toUpperCase();

  for (int i = 0; i < ramInsideCount; i++) {
    String inUid = String(ramInsideList[i].uid);
    inUid.replace(" ", "");
    inUid.toUpperCase();
    if (inUid == cleanUid) {
      ramInsideList[i].timestamp = millis();
      return;
    }
  }

  if (ramInsideCount < MAX_INSIDE_RECORDS) {
    strncpy(ramInsideList[ramInsideCount].uid, uid.c_str(),
            sizeof(ramInsideList[ramInsideCount].uid) - 1);
    ramInsideList[ramInsideCount].timestamp = millis();
    ramInsideCount++;
  } else {
    for (int i = 0; i < MAX_INSIDE_RECORDS - 1; i++) {
      ramInsideList[i] = ramInsideList[i + 1];
    }
    strncpy(ramInsideList[MAX_INSIDE_RECORDS - 1].uid, uid.c_str(),
            sizeof(ramInsideList[MAX_INSIDE_RECORDS - 1].uid) - 1);
    ramInsideList[MAX_INSIDE_RECORDS - 1].timestamp = millis();
  }
}

void syncInsideStatusFromCloud() {
  if (!wifiConnected || WiFi.status() != WL_CONNECTED)
    return;
  lcdMsg("SYNCING DATABASE", "CAMPUS PRESENCE");
  String url = String(SUPABASE_URL) +
               "/rest/v1/"
               "transactions?status=eq.AUTHORIZED&order=timestamp.desc&limit="
               "100&select=rfid_uid,direction";
  WiFiClientSecure insideClient;
  insideClient.setInsecure();
  insideClient.setHandshakeTimeout(8);

  HTTPClient http;
  http.begin(insideClient, url);
  http.setTimeout(4000);
  http.addHeader("apikey", SUPABASE_ANON);
  http.addHeader("Authorization", String("Bearer ") + SUPABASE_ANON);
  int code = http.GET();
  if (code == 200) {
    DynamicJsonDocument doc(4096);
    if (deserializeJson(doc, http.getString()) == DeserializationError::Ok) {
      JsonArray arr = doc.as<JsonArray>();
      for (JsonObject item : arr) {
        String uid = String(item["rfid_uid"] | "");
        String dir = String(item["direction"] | "");
        if (uid.length() > 0) {
          if (dir == "ENTRY") {
            markInsideFast(uid);
          } else if (dir == "EXIT") {
            clearInsideFast(uid);
          }
        }
      }
      Serial.printf(
          "[INSIDE SYNC] Seeded inside presence: %d cards inside campus.\n",
          ramInsideCount);
      lcdMsg("PRESENCE SYNCED", String(ramInsideCount) + " INSIDE CAMPUS");
      delay(600);
    }
  }
  http.end();
}

void syncWhitelistToSD() {
  if (!wifiConnected || WiFi.status() != WL_CONNECTED || !sdCardReady)
    return;

  Serial.println("\n[SD & RAM SYNC] Starting fast paginated whitelist sync "
                 "from Supabase (EXIT)...");
  lcdMsg("SYNCING DATABASE", "CONNECTING...");

  const char *TEMP_WHITELIST = "/auth_cards_exit.tmp";
  if (SD.exists(TEMP_WHITELIST)) {
    SD.remove(TEMP_WHITELIST);
  }

  int totalSynced = 0;
  int offset = 0;
  const int BATCH_SIZE = 20;
  bool syncSuccess = true;

  // Clear RAM count to repopulate fresh
  ramWhitelistCount = 0;

  // Verify DNS resolution for Supabase before making HTTPS requests
  IPAddress hostIp;
  if (!WiFi.hostByName("xrdpgsnastqnbhvdltwt.supabase.co", hostIp)) {
    Serial.println("[DNS] Resolving Supabase via router DNS failed, trying "
                   "8.8.8.8 fallback...");
    WiFi.setDNS(IPAddress(8, 8, 8, 8), IPAddress(1, 1, 1, 1));
    if (!WiFi.hostByName("xrdpgsnastqnbhvdltwt.supabase.co", hostIp)) {
      Serial.println("[DNS ERROR] Cannot resolve Supabase hostname! Check "
                     "router or internet connection.");
    } else {
      Serial.printf("[DNS OK] Supabase resolved via fallback DNS: %s\n",
                    hostIp.toString().c_str());
    }
  } else {
    Serial.printf("[DNS OK] Supabase resolved to: %s\n",
                  hostIp.toString().c_str());
  }

  while (true) {
    if (offset == 0) {
      lcdMsg("SYNCING DATABASE", "FETCHING CARDS..");
    } else {
      lcdMsg("SYNCING DATABASE", "FETCHED: " + String(totalSynced));
    }

    String url = String(SUPABASE_URL) +
                 "/rest/v1/rfid_cards?authorization_status=eq.AUTHORIZED"
                 "&select=rfid_uid,vehicle_id,user_id,rfid_type,user_type,"
                 "vehicles(plate_number,vehicle_type),"
                 "users(full_name,role,default_transit_mode)"
                 "&order=rfid_uid.asc&limit=" +
                 String(BATCH_SIZE) + "&offset=" + String(offset);

    int code = -1;
    String body = "";
    const int MAX_PAGE_RETRIES = 3;

    for (int retry = 1; retry <= MAX_PAGE_RETRIES; retry++) {
      WiFiClientSecure client;
      client.setInsecure();
      client.setHandshakeTimeout(8);

      HTTPClient http;
      http.begin(client, url);
      http.setTimeout(8000);
      http.addHeader("apikey", SUPABASE_ANON);
      http.addHeader("Authorization", String("Bearer ") + SUPABASE_ANON);

      code = http.GET();
      if (code == 200) {
        body = http.getString();
        http.end();
        break;
      }

      char sslErr[128] = {0};
      int sslCode = client.lastError(sslErr, sizeof(sslErr));
      String errStr = http.errorToString(code);
      http.end();
      Serial.printf(
          "[SD SYNC] Page fetch attempt %d/%d failed at offset %d (HTTP %d: %s "
          "| SSL %d: %s | FreeHeap: %d / MaxBlock: %d)\n",
          retry, MAX_PAGE_RETRIES, offset, code, errStr.c_str(), sslCode,
          sslErr, ESP.getFreeHeap(), ESP.getMaxAllocHeap());
      if (retry < MAX_PAGE_RETRIES) {
        lcdMsg("DB RETRY " + String(retry + 1) + "/3", "WAITING RETRY");
        delay(800);
      }
    }

    if (code != 200) {
      Serial.printf("[SD SYNC] All %d attempts failed at offset %d (HTTP %d)\n",
                    MAX_PAGE_RETRIES, offset, code);
      syncSuccess = false;
      lcdMsg("DB SYNC FAILED", "HTTP CODE: " + String(code));
      delay(1200);
      break;
    }

    DynamicJsonDocument doc(8192);
    DeserializationError jsonErr = deserializeJson(doc, body);
    if (jsonErr) {
      Serial.printf("[SD SYNC ERROR] deserializeJson failed at offset %d: %s "
                    "(Payload: %d bytes, Heap: %d)\n",
                    offset, jsonErr.c_str(), body.length(), ESP.getFreeHeap());
      syncSuccess = false;
      lcdMsg("DB SYNC FAILED", "JSON PARSE FAIL");
      delay(1200);
      break;
    }

    JsonArray arr = doc.as<JsonArray>();
    int countInPage = arr.size();
    if (countInPage == 0) {
      break; // No more records
    }

    // Open file to append page records
    File f = SD.open(TEMP_WHITELIST, offset == 0 ? FILE_WRITE : FILE_APPEND);
    if (f) {
      if (offset == 0) {
        f.println("UID,NAME,PLATE,ROLE,USER_TYPE,RFID_TYPE,VEHICLE_ID,USER_ID");
      }
      for (JsonObject card : arr) {
        String uid = String(card["rfid_uid"] | "");
        uid.trim();
        if (uid.length() == 0)
          continue;

        String name = "";
        String role = "";
        String plate = "--";
        String userType = String(card["user_type"] | "PEDESTRIAN");
        String rfidType = String(card["rfid_type"] | "CLOSE_RANGE");
        String vehicleId = String(card["vehicle_id"] | "");
        String userId = String(card["user_id"] | "");

        if (!card["users"].isNull()) {
          name = String(card["users"]["full_name"] | "");
          role = String(card["users"]["role"] | "");
          String defMode = String(card["users"]["default_transit_mode"] | "");
          if (defMode == "PEDESTRIAN") {
            userType = "PEDESTRIAN";
            rfidType = "CLOSE_RANGE";
          }
        }
        if (!card["vehicles"].isNull()) {
          plate = String(card["vehicles"]["plate_number"] | "--");
          String vType = String(card["vehicles"]["vehicle_type"] | "");
          if (vType == "None" || plate == "PEDESTRIAN") {
            userType = "PEDESTRIAN";
            rfidType = "CLOSE_RANGE";
          }
        }
        name.replace(",", " ");
        plate.replace(",", " ");

        f.println(uid + "," + name + "," + plate + "," + role + "," + userType +
                  "," + rfidType + "," + vehicleId + "," + userId);

        if (ramWhitelist != NULL && ramWhitelistCount < MAX_RAM_CARDS) {
          WhitelistCard &wc = ramWhitelist[ramWhitelistCount];
          memset(&wc, 0, sizeof(WhitelistCard));
          strncpy(wc.uid, uid.c_str(), sizeof(wc.uid) - 1);
          strncpy(wc.name, name.c_str(), sizeof(wc.name) - 1);
          strncpy(wc.plate, plate.c_str(), sizeof(wc.plate) - 1);
          strncpy(wc.role, role.c_str(), sizeof(wc.role) - 1);
          strncpy(wc.userType, userType.c_str(), sizeof(wc.userType) - 1);
          strncpy(wc.rfidType, rfidType.c_str(), sizeof(wc.rfidType) - 1);
          strncpy(wc.vehicleId, vehicleId.c_str(), sizeof(wc.vehicleId) - 1);
          strncpy(wc.userId, userId.c_str(), sizeof(wc.userId) - 1);
          ramWhitelistCount++;
        }
        totalSynced++;
      }
      f.close();
    }

    offset += countInPage;
    lcdMsg("SYNCING DATABASE", "CACHED: " + String(totalSynced) + " CARDS");
    if (countInPage < BATCH_SIZE) {
      break; // Last page reached
    }
    delay(100);
  }

  // Also cache special tags (Emergency & Visitor passes) into RAM & SD
  lcdMsg("SYNCING DATABASE", "VISITOR PASSES..");
  String specialUrl =
      String(SUPABASE_URL) +
      "/rest/v1/special_tags?select=rfid_uid,type,label,description";
  WiFiClientSecure specClient;
  specClient.setInsecure();
  specClient.setHandshakeTimeout(8);

  HTTPClient httpSpec;
  httpSpec.begin(specClient, specialUrl);
  httpSpec.setTimeout(5000);
  httpSpec.addHeader("apikey", SUPABASE_ANON);
  httpSpec.addHeader("Authorization", String("Bearer ") + SUPABASE_ANON);
  int specCode = httpSpec.GET();
  if (specCode == 200) {
    String specBody = httpSpec.getString();
    httpSpec.end();
    DynamicJsonDocument specDoc(4096);
    if (deserializeJson(specDoc, specBody) == DeserializationError::Ok) {
      JsonArray specArr = specDoc.as<JsonArray>();
      File fSpec = SD.open(TEMP_WHITELIST, FILE_APPEND);
      for (JsonObject tag : specArr) {
        String uid = String(tag["rfid_uid"] | "");
        uid.trim();
        if (uid.length() == 0)
          continue;
        String type = String(tag["type"] | "VISITOR");
        String label =
            String(tag["label"] | (type == "EMERGENCY" ? "Emergency Vehicle"
                                                       : "Visitor Pass"));
        label.replace(",", " ");

        if (fSpec) {
          fSpec.println(uid + "," + label + "," +
                        (type == "EMERGENCY" ? "EMERGENCY" : "VISITOR") + "," +
                        type + ",PEDESTRIAN,CLOSE_RANGE,,");
        }

        if (ramWhitelist != NULL && ramWhitelistCount < MAX_RAM_CARDS) {
          WhitelistCard &wc = ramWhitelist[ramWhitelistCount];
          memset(&wc, 0, sizeof(WhitelistCard));
          strncpy(wc.uid, uid.c_str(), sizeof(wc.uid) - 1);
          strncpy(wc.name, label.c_str(), sizeof(wc.name) - 1);
          strncpy(wc.plate, type == "EMERGENCY" ? "EMERGENCY" : "VISITOR",
                  sizeof(wc.plate) - 1);
          strncpy(wc.role, type.c_str(), sizeof(wc.role) - 1);
          strncpy(wc.userType, "PEDESTRIAN", sizeof(wc.userType) - 1);
          strncpy(wc.rfidType, "CLOSE_RANGE", sizeof(wc.rfidType) - 1);
          ramWhitelistCount++;
        }
      }
      if (fSpec)
        fSpec.close();
      Serial.println("[SD & RAM SYNC] Added special tags. Total RAM cards: " +
                     String(ramWhitelistCount));
    }
  } else {
    httpSpec.end();
  }

  if (syncSuccess && totalSynced > 0) {
    SD.remove(WHITELIST_FILE);
    SD.rename(TEMP_WHITELIST, WHITELIST_FILE);
    Serial.printf("[SD & RAM SYNC] SUCCESS! Saved %d cards to SD (%s) and "
                  "loaded %d into RAM (EXIT).\n",
                  totalSynced, WHITELIST_FILE, ramWhitelistCount);
    lcdMsg("DB SYNC SUCCESS", String(totalSynced) + " CARDS READY");
    delay(1000);
  } else {
    SD.remove(TEMP_WHITELIST);
    if (!syncSuccess) {
      Serial.println("[SD & RAM SYNC] Sync encountered an issue. Retaining "
                     "existing SD cache.");
      lcdMsg("DB SYNC ISSUE", "USING SD CACHE");
      delay(1000);
      loadWhitelistFromSDToRAM();
    }
  }

  // Seed inside presence from cloud
  syncInsideStatusFromCloud();

  lastWhitelistSync = millis();
}

// Forward declaration of visitor tag reset
void resetVisitorTagOnline(String uid);

// =======================
// ASYNCHRONOUS TRANSACTION QUEUE & CLOUD LOGGING (NON-BLOCKING)
// =======================
void enqueueTransaction(String uid, String status, String remarks, String uType,
                        String rType, String vId, String uId, bool isVisitor) {
  if (txQueueCount >= MAX_TX_QUEUE) {
    // Spill oldest to SD offline log to prevent buffer drop
    QueuedTransaction &old = txQueue[txQueueHead];
    saveOfflineTransaction(String(old.uid), String(old.status),
                           String(old.remarks));
    txQueueHead = (txQueueHead + 1) % MAX_TX_QUEUE;
    txQueueCount--;
  }

  QueuedTransaction &item = txQueue[txQueueTail];
  memset(&item, 0, sizeof(QueuedTransaction));
  strncpy(item.uid, uid.c_str(), sizeof(item.uid) - 1);
  strncpy(item.status, status.c_str(), sizeof(item.status) - 1);
  strncpy(item.remarks, remarks.c_str(), sizeof(item.remarks) - 1);
  strncpy(item.userType, uType.c_str(), sizeof(item.userType) - 1);
  strncpy(item.rfidType, rType.c_str(), sizeof(item.rfidType) - 1);
  strncpy(item.vehicleId, vId.c_str(), sizeof(item.vehicleId) - 1);
  strncpy(item.userId, uId.c_str(), sizeof(item.userId) - 1);
  item.isVisitor = isVisitor;

  txQueueTail = (txQueueTail + 1) % MAX_TX_QUEUE;
  txQueueCount++;
  Serial.printf("[QUEUE] Transaction queued for UID %s (%s). Queue depth: %d\n",
                uid.c_str(), status.c_str(), txQueueCount);
}

void sendTransactionToCloud(const QueuedTransaction &item) {
  if (!wifiConnected || WiFi.status() != WL_CONNECTED) {
    saveOfflineTransaction(String(item.uid), String(item.status),
                           String(item.remarks));
    return;
  }

  String url = String(SUPABASE_URL) + "/rest/v1/transactions";
  HTTPClient http;
  http.begin(secureClient, url);
  http.setTimeout(2500);
  http.addHeader("Content-Type", "application/json");
  http.addHeader("apikey", SUPABASE_ANON);
  http.addHeader("Authorization", String("Bearer ") + SUPABASE_ANON);
  http.addHeader("Prefer", "return=minimal");

  DynamicJsonDocument doc(512);
  doc["rfid_uid"] = item.uid;
  doc["direction"] = GATE_TYPE;
  doc["gate"] = GATE_ID;
  doc["status"] = item.status;
  doc["remarks"] = item.remarks;
  doc["user_type"] = (strlen(item.userType) > 0) ? item.userType : "PEDESTRIAN";
  doc["rfid_type"] =
      (strlen(item.rfidType) > 0) ? item.rfidType : "CLOSE_RANGE";

  if (strlen(item.vehicleId) > 0 && strcmp(item.vehicleId, "null") != 0 &&
      strcmp(item.vehicleId, "") != 0)
    doc["vehicle_id"] = item.vehicleId;
  if (strlen(item.userId) > 0 && strcmp(item.userId, "null") != 0 &&
      strcmp(item.userId, "") != 0)
    doc["user_id"] = item.userId;

  String body;
  serializeJson(doc, body);
  int code = http.POST(body);
  if (code >= 200 && code < 300) {
    Serial.printf("[SUPABASE CLOUD] Synced %s (%s) successfully.\n", item.uid,
                  item.status);
    if (item.isVisitor) {
      resetVisitorTagOnline(String(item.uid));
    }
  } else {
    Serial.printf("[SUPABASE POST ERROR] HTTP %d. Storing to SD offline log.\n",
                  code);
    saveOfflineTransaction(String(item.uid), String(item.status),
                           String(item.remarks));
  }
  http.end();
}

void processCloudQueue() {
  if (txQueueCount == 0 || !wifiConnected || WiFi.status() != WL_CONNECTED)
    return;

  static unsigned long lastQueueAttempt = 0;
  if (millis() - lastQueueAttempt < 100)
    return;
  lastQueueAttempt = millis();

  QueuedTransaction item = txQueue[txQueueHead];
  txQueueHead = (txQueueHead + 1) % MAX_TX_QUEUE;
  txQueueCount--;

  sendTransactionToCloud(item);
}

void insertTransactionOnline(String uid, String status, String remarks,
                             bool isVisitor) {
  if (wifiConnected) {
    enqueueTransaction(uid, status, remarks, card_userType, card_rfidType,
                       card_vehicleId, card_userId, isVisitor);
  } else {
    saveOfflineTransaction(uid, status, remarks);
  }
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
  card_userType = "PEDESTRIAN";
  card_rfidType = "CLOSE_RANGE";
  card_vehicleId = "";
  card_userId = "";

  if (!sdCardReady || !SD.exists(WHITELIST_FILE)) {
    Serial.println("[SD] Whitelist file not found on SD card");
    return false;
  }

  String cleanUid = uid;
  cleanUid.replace(" ", "");
  cleanUid.toUpperCase();

  File f = SD.open(WHITELIST_FILE, FILE_READ);
  if (!f)
    return false;

  while (f.available()) {
    String line = f.readStringUntil('\n');
    line.trim();
    if (line.length() == 0 || line.startsWith("UID,"))
      continue;

    int c1 = line.indexOf(',');
    if (c1 <= 0)
      continue;

    String fileUid = line.substring(0, c1);
    fileUid.replace(" ", "");
    fileUid.toUpperCase();

    if (fileUid == cleanUid) {
      card_found = true;
      card_authorized = true;

      int c2 = line.indexOf(',', c1 + 1);
      int c3 = (c2 > 0) ? line.indexOf(',', c2 + 1) : -1;
      int c4 = (c3 > 0) ? line.indexOf(',', c3 + 1) : -1;
      int c5 = (c4 > 0) ? line.indexOf(',', c4 + 1) : -1;
      int c6 = (c5 > 0) ? line.indexOf(',', c5 + 1) : -1;
      int c7 = (c6 > 0) ? line.indexOf(',', c6 + 1) : -1;

      if (c2 > 0)
        card_name = line.substring(c1 + 1, c2);
      if (c2 > 0 && c3 > 0)
        card_plate = line.substring(c2 + 1, c3);
      if (c3 > 0 && c4 > 0)
        card_role = line.substring(c3 + 1, c4);
      if (c4 > 0 && c5 > 0)
        card_userType = line.substring(c4 + 1, c5);
      if (c5 > 0 && c6 > 0)
        card_rfidType = line.substring(c5 + 1, c6);
      if (c6 > 0 && c7 > 0)
        card_vehicleId = line.substring(c6 + 1, c7);
      if (c7 > 0)
        card_userId = line.substring(c7 + 1);

      Serial.println("[SD AUTH] Found offline card: " + card_name + " (" +
                     cleanUid + ")");
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
  if (!wifiConnected || !sdCardReady || !SD.exists(OFFLINE_TXNS_FILE))
    return;

  File f = SD.open(OFFLINE_TXNS_FILE, FILE_READ);
  if (!f || f.size() == 0) {
    if (f)
      f.close();
    return;
  }

  Serial.println("[SYNC] Found offline transactions. Syncing to Supabase...");
  lcdMsg("SYNCING LOGS...", "Please wait...");

  int syncedCount = 0;
  while (f.available()) {
    String line = f.readStringUntil('\n');
    line.trim();
    if (line.length() == 0)
      continue;

    int c1 = line.indexOf(',');
    int c2 = line.indexOf(',', c1 + 1);
    int c3 = line.indexOf(',', c2 + 1);
    int c4 = line.indexOf(',', c3 + 1);
    int c5 = line.indexOf(',', c4 + 1);

    if (c1 > 0 && c2 > 0 && c3 > 0) {
      String uid = line.substring(0, c1);
      String direction = line.substring(c1 + 1, c2);
      String status = line.substring(c2 + 1, c3);
      String remarks =
          (c4 > 0) ? line.substring(c3 + 1, c4) : line.substring(c3 + 1);
      String name = (c4 > 0 && c5 > 0) ? line.substring(c4 + 1, c5) : "";
      String plate = (c5 > 0) ? line.substring(c5 + 1) : "";

      String url = String(SUPABASE_URL) + "/rest/v1/transactions";
      HTTPClient http;
      http.begin(secureClient, url);
      http.setTimeout(4000);
      http.addHeader("Content-Type", "application/json");
      http.addHeader("apikey", SUPABASE_ANON);
      http.addHeader("Authorization", String("Bearer ") + SUPABASE_ANON);

      DynamicJsonDocument doc(512);
      doc["rfid_uid"] = uid;
      doc["direction"] = direction;
      doc["gate"] = GATE_ID;
      doc["status"] = status;
      doc["remarks"] =
          "[OFFLINE SYNC] " + remarks + " (" + name + " / " + plate + ")";

      String body;
      serializeJson(doc, body);
      int code = http.POST(body);
      if (code >= 200 && code < 300)
        syncedCount++;
      http.end();
      delay(80);
    }
  }
  f.close();

  SD.remove(OFFLINE_TXNS_FILE);
  Serial.println("[SYNC] Synced " + String(syncedCount) +
                 " offline records to cloud.");
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
  String specialUrl = String(SUPABASE_URL) +
                      "/rest/v1/special_tags?rfid_uid=eq." + urlEncode(uid) +
                      "&select=type,label,description";
  HTTPClient httpSpec;
  httpSpec.begin(secureClient, specialUrl);
  httpSpec.setTimeout(4000);
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
  String url =
      String(SUPABASE_URL) + "/rest/v1/rfid_cards?rfid_uid=eq." +
      urlEncode(uid) +
      "&select=authorization_status,vehicle_id,user_id,rfid_type,user_type,"
      "vehicles(plate_number,vehicle_type),"
      "users(full_name,role,default_transit_mode)";

  HTTPClient http;
  http.begin(secureClient, url);
  http.setTimeout(4000);
  http.addHeader("apikey", SUPABASE_ANON);
  http.addHeader("Authorization", String("Bearer ") + SUPABASE_ANON);

  int code = http.GET();
  String body = "";
  if (code == 200)
    body = http.getString();
  http.end();

  DynamicJsonDocument doc(1024);
  if (deserializeJson(doc, body) != DeserializationError::Ok)
    return false;

  JsonArray arr = doc.as<JsonArray>();
  if (arr.size() == 0)
    return false;

  JsonObject card = arr[0];
  card_found = true;
  card_authorized =
      (String(card["authorization_status"].as<const char *>()) == "AUTHORIZED");
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
// RESET REUSABLE VISITOR TAG
// =======================
void resetVisitorTagOnline(String uid) {
  String url = String(SUPABASE_URL) + "/rest/v1/special_tags?rfid_uid=eq." +
               urlEncode(uid) + "&type=eq.VISITOR";
  HTTPClient http;
  http.begin(secureClient, url);
  http.setTimeout(4000);
  http.addHeader("Content-Type", "application/json");
  http.addHeader("apikey", SUPABASE_ANON);
  http.addHeader("Authorization", String("Bearer ") + SUPABASE_ANON);
  DynamicJsonDocument doc(256);
  doc["label"] = "Reusable Visitor Tag";
  doc["description"] = (char *)NULL;
  String body;
  serializeJson(doc, body);
  http.PATCH(body);
  http.end();
  Serial.println("[VISITOR] Tag " + uid + " reset to vacant/reusable state.");
}

// =======================
// ONLINE DOUBLE EXIT / PRIOR STATE CHECK
// =======================
bool checkExitConflictOnline(String uid, String &conflictMsg,
                             String &conflictDetail) {
  String url = String(SUPABASE_URL) + "/rest/v1/transactions?rfid_uid=eq." +
               urlEncode(uid) +
               "&status=eq.AUTHORIZED&order=timestamp.desc&limit=1&select="
               "direction,timestamp";

  HTTPClient http;
  http.begin(secureClient, url);
  http.setTimeout(4000);
  http.addHeader("apikey", SUPABASE_ANON);
  http.addHeader("Authorization", String("Bearer ") + SUPABASE_ANON);

  int code = http.GET();
  String body = "";
  if (code == 200)
    body = http.getString();
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
      String lastTs = String(arr[0]["timestamp"] | "");
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
// FAST LOCAL VERIFICATION
// =======================
bool checkAuthorizationFast(String uid) {
  card_found = false;
  card_authorized = false;
  card_name = "";
  card_plate = "";
  card_role = "";
  card_userType = "PEDESTRIAN";
  card_rfidType = "CLOSE_RANGE";
  card_vehicleId = "";
  card_userId = "";

  String cleanUid = uid;
  cleanUid.replace(" ", "");
  cleanUid.toUpperCase();

  // 1. Check RAM Whitelist first (< 0.01ms lookup)
  if (ramWhitelist != NULL) {
    for (int i = 0; i < ramWhitelistCount; i++) {
      String ramUid = String(ramWhitelist[i].uid);
      ramUid.replace(" ", "");
      ramUid.toUpperCase();
      if (ramUid == cleanUid) {
        card_found = true;
        card_authorized = true;
        card_name = String(ramWhitelist[i].name);
        card_plate = String(ramWhitelist[i].plate);
        card_role = String(ramWhitelist[i].role);
        card_userType = strlen(ramWhitelist[i].userType) > 0
                            ? String(ramWhitelist[i].userType)
                            : "PEDESTRIAN";
        card_rfidType = strlen(ramWhitelist[i].rfidType) > 0
                            ? String(ramWhitelist[i].rfidType)
                            : "CLOSE_RANGE";
        card_vehicleId = String(ramWhitelist[i].vehicleId);
        card_userId = String(ramWhitelist[i].userId);
        return true;
      }
    }
  }

  // 2. Check SD Card Whitelist (< 15ms)
  if (checkAuthorizationOffline(uid)) {
    // Dynamically promote to RAM cache so next read is < 0.01ms
    if (ramWhitelist != NULL && ramWhitelistCount < MAX_RAM_CARDS) {
      WhitelistCard &wc = ramWhitelist[ramWhitelistCount];
      memset(&wc, 0, sizeof(WhitelistCard));
      strncpy(wc.uid, uid.c_str(), sizeof(wc.uid) - 1);
      strncpy(wc.name, card_name.c_str(), sizeof(wc.name) - 1);
      strncpy(wc.plate, card_plate.c_str(), sizeof(wc.plate) - 1);
      strncpy(wc.role, card_role.c_str(), sizeof(wc.role) - 1);
      strncpy(wc.userType, card_userType.c_str(), sizeof(wc.userType) - 1);
      strncpy(wc.rfidType, card_rfidType.c_str(), sizeof(wc.rfidType) - 1);
      strncpy(wc.vehicleId, card_vehicleId.c_str(), sizeof(wc.vehicleId) - 1);
      strncpy(wc.userId, card_userId.c_str(), sizeof(wc.userId) - 1);
      ramWhitelistCount++;
    }
    return true;
  }

  // 3. Fallback to single Cloud lookup only if Wi-Fi connected and not in local
  // cache
  if (wifiConnected) {
    if (checkAuthorizationOnline(uid)) {
      if (ramWhitelist != NULL && ramWhitelistCount < MAX_RAM_CARDS) {
        WhitelistCard &wc = ramWhitelist[ramWhitelistCount];
        memset(&wc, 0, sizeof(WhitelistCard));
        strncpy(wc.uid, uid.c_str(), sizeof(wc.uid) - 1);
        strncpy(wc.name, card_name.c_str(), sizeof(wc.name) - 1);
        strncpy(wc.plate, card_plate.c_str(), sizeof(wc.plate) - 1);
        strncpy(wc.role, card_role.c_str(), sizeof(wc.role) - 1);
        strncpy(wc.userType, card_userType.c_str(), sizeof(wc.userType) - 1);
        strncpy(wc.rfidType, card_rfidType.c_str(), sizeof(wc.rfidType) - 1);
        strncpy(wc.vehicleId, card_vehicleId.c_str(), sizeof(wc.vehicleId) - 1);
        strncpy(wc.userId, card_userId.c_str(), sizeof(wc.userId) - 1);
        ramWhitelistCount++;
      }
      return true;
    }
  }

  return false;
}

void clearInsideFast(String uid) {
  if (ramInsideList == NULL)
    return;
  String cleanUid = uid;
  cleanUid.replace(" ", "");
  cleanUid.toUpperCase();

  for (int i = 0; i < ramInsideCount; i++) {
    String inUid = String(ramInsideList[i].uid);
    inUid.replace(" ", "");
    inUid.toUpperCase();
    if (inUid == cleanUid) {
      for (int j = i; j < ramInsideCount - 1; j++) {
        ramInsideList[j] = ramInsideList[j + 1];
      }
      ramInsideCount--;
      break;
    }
  }
}

void markExitedLocal(String uid) {
  String cleanUid = uid;
  cleanUid.replace(" ", "");
  cleanUid.toUpperCase();

  unsigned long now = millis();
  for (int i = 0; i < ramRecentExitsCount; i++) {
    String exUid = String(ramRecentExits[i].uid);
    exUid.replace(" ", "");
    exUid.toUpperCase();
    if (exUid == cleanUid) {
      ramRecentExits[i].timestamp = now;
      return;
    }
  }

  if (ramRecentExitsCount < MAX_RECENT_EXITS) {
    strncpy(ramRecentExits[ramRecentExitsCount].uid, uid.c_str(),
            sizeof(ramRecentExits[ramRecentExitsCount].uid) - 1);
    ramRecentExits[ramRecentExitsCount].timestamp = now;
    ramRecentExitsCount++;
  } else {
    for (int i = 0; i < MAX_RECENT_EXITS - 1; i++) {
      ramRecentExits[i] = ramRecentExits[i + 1];
    }
    strncpy(ramRecentExits[MAX_RECENT_EXITS - 1].uid, uid.c_str(),
            sizeof(ramRecentExits[MAX_RECENT_EXITS - 1].uid) - 1);
    ramRecentExits[MAX_RECENT_EXITS - 1].timestamp = now;
  }
}

bool checkAlreadyExitedLocal(String uid, String &conflictDetail) {
  String cleanUid = uid;
  cleanUid.replace(" ", "");
  cleanUid.toUpperCase();

  unsigned long now = millis();
  for (int i = 0; i < ramRecentExitsCount; i++) {
    String exUid = String(ramRecentExits[i].uid);
    exUid.replace(" ", "");
    exUid.toUpperCase();
    if (exUid == cleanUid) {
      unsigned long elapsedSec = (now - ramRecentExits[i].timestamp) / 1000;
      if (elapsedSec < 60) {
        conflictDetail = "Out " + String(elapsedSec) + "s ago";
      } else if (elapsedSec < 3600) {
        conflictDetail = "Out " + String(elapsedSec / 60) + "m ago";
      } else {
        conflictDetail = "Out >1h ago";
      }
      return true;
    }
  }
  return false;
}

void showReadyNonBlocking(unsigned long holdMs) {
  readyResetTime = millis() + holdMs;
  isDisplayHolding = true;
}

// =======================
// PROCESS SCAN (Ultra-Fast Sub-50ms Local-First Engine — EXIT)
// =======================
void processScan(String uid) {
  // Traffic Light: YELLOW = SCANNING
  setTrafficLight(false, true, false);

  Serial.println("[SCAN] UID: " + uid);
  lcdMsg("SCANNING...", uid.substring(0, 16));

  // 1. Fast Local Authorization (< 50ms)
  bool authorized = checkAuthorizationFast(uid);

  if (!card_found) {
    Serial.println("[RESULT] ACCESS DENIED — Unregistered Card");
    lcdMsg("ACCESS DENIED", "UNREGISTERED");
    tone(BUZZER_PIN, 500, 300);
    setTrafficLight(false, false, false);
    blinkLED(RED_LED, 3);
    if (!wifiConnected || WiFi.status() != WL_CONNECTED) {
      setTrafficLight(false, true, false);
    } else {
      setTrafficLight(true, false, false); // Return to RED standby
    }

    if (wifiConnected) {
      enqueueTransaction(uid, "DENIED", "Unregistered RFID Card", card_userType,
                         card_rfidType, card_vehicleId, card_userId);
    } else {
      saveOfflineTransaction(uid, "DENIED", "Unregistered RFID Card");
    }
    showReadyNonBlocking(1200);
    return;
  }

  if (!authorized) {
    Serial.println("[RESULT] UNAUTHORIZED — Pending Approval");
    lcdMsg("UNAUTHORIZED", "PENDING APPROVAL");
    tone(BUZZER_PIN, 500, 300);
    setTrafficLight(false, false, false);
    blinkLED(RED_LED, 2);
    if (!wifiConnected || WiFi.status() != WL_CONNECTED) {
      setTrafficLight(false, true, false);
    } else {
      setTrafficLight(true, false, false); // Return to RED standby
    }

    if (wifiConnected) {
      enqueueTransaction(uid, "DENIED", "Card authorization pending",
                         card_userType, card_rfidType, card_vehicleId,
                         card_userId);
    } else {
      saveOfflineTransaction(uid, "DENIED", "Card authorization pending");
    }
    showReadyNonBlocking(1200);
    return;
  }

  // 2. Fast In-Memory Anti-Passback Exit Tracking (< 0.01ms)
  if (card_role != "EMERGENCY") {
    String conflictDetail = "";
    if (checkAlreadyExitedLocal(uid, conflictDetail)) {
      Serial.println("[RESULT] EXIT DENIED — ALREADY EXITED (" +
                     conflictDetail + ")");
      lcdMsg("ALREADY EXITED", conflictDetail);
      tone(BUZZER_PIN, 500, 300);
      setTrafficLight(false, false, false);
      blinkLED(RED_LED, 2);
      if (!wifiConnected || WiFi.status() != WL_CONNECTED) {
        setTrafficLight(false, true, false);
      } else {
        setTrafficLight(true, false, false); // Return to RED standby
      }

      if (wifiConnected) {
        enqueueTransaction(
            uid, "DENIED",
            "Passback violation: ALREADY EXITED (" + conflictDetail + ")",
            card_userType, card_rfidType, card_vehicleId, card_userId);
      } else {
        saveOfflineTransaction(uid, "DENIED",
                               "Passback violation: ALREADY EXITED (" +
                                   conflictDetail + ")");
      }
      showReadyNonBlocking(1400);
      return;
    }
  }

  // 3. Authorized Exit — Update State & Clear Inside Status
  markExitedLocal(uid);
  clearInsideFast(uid);
  Serial.println("[RESULT] AUTHORIZED EXIT (Granted) — " + card_name);
  String plateLine =
      (card_plate.length() > 0 && card_plate != "--")
          ? card_plate
          : (card_name.length() > 0 ? card_name : uid.substring(0, 16));

  lcdMsg("EXIT GRANTED", plateLine);
  tone(BUZZER_PIN, 2000, 100);
  delay(50);
  tone(BUZZER_PIN, 2500, 120);

  // Traffic Light: DONE = GREEN ON, YELLOW OFF, RED OFF
  setTrafficLight(false, false, true);

  bool isVisitor = (card_role == "VISITOR");
  String remarks = "EXIT gate scan (Instant Fast Cache)";
  if (card_role == "EMERGENCY") {
    remarks = "Emergency tag: " +
              (card_name.length() > 0 ? card_name : "Emergency Response");
  } else if (isVisitor) {
    remarks =
        "Visitor Exit: " + (card_name.length() > 0 ? card_name : "Visitor") +
        " | Plate: " + card_plate;
  }

  // 4. Zero-delay Asynchronous Queue (Enqueued in < 1us)
  if (wifiConnected) {
    enqueueTransaction(uid, "AUTHORIZED", remarks, card_userType, card_rfidType,
                       card_vehicleId, card_userId, isVisitor);
  } else {
    saveOfflineTransaction(uid, "AUTHORIZED", remarks);
  }

  // Return to ready display after non-blocking 0.9s window (never gets stuck on
  // exited name!)
  showReadyNonBlocking(900);
}

void sendDeviceHeartbeat() {
  if (WiFi.status() != WL_CONNECTED)
    return;

  // 1. Check for Over-The-Air Wi-Fi Reconfiguration Commands from Supabase
  // Admin Dashboard
  HTTPClient checkHttp;
  String checkUrl = String(SUPABASE_URL) +
                    "/rest/v1/devices?esp32_identifier=eq." + String(GATE_ID) +
                    "&select=target_ssid,target_pass";
  checkHttp.begin(secureClient, checkUrl);
  checkHttp.setTimeout(4000);
  checkHttp.addHeader("apikey", SUPABASE_ANON);
  checkHttp.addHeader("Authorization", String("Bearer ") + SUPABASE_ANON);

  int getCode = checkHttp.GET();
  if (getCode == 200) {
    String resp = checkHttp.getString();
    DynamicJsonDocument doc(512);
    DeserializationError jsonErr = deserializeJson(doc, resp);
    if (!jsonErr && doc.is<JsonArray>() && doc.as<JsonArray>().size() > 0) {
      JsonObject devObj = doc[0];
      if (!devObj["target_ssid"].isNull()) {
        String newSsid = devObj["target_ssid"].as<String>();
        String newPass = devObj["target_pass"].isNull()
                             ? ""
                             : devObj["target_pass"].as<String>();
        newSsid.trim();
        newPass.trim();

        if (newSsid.length() > 0 && newSsid != "null" &&
            newSsid != "target_pass") {
          Serial.println("\n🌐 [REMOTE CLOUD CMD] Received Wi-Fi Change "
                         "request for SSID: '" +
                         newSsid + "'");
          lcdMsg("REMOTE WIFI CMD", newSsid.substring(0, 16));
          checkHttp.end();

          // Clear target_ssid in Supabase first to prevent loops
          HTTPClient clearHttp;
          String clearUrl = String(SUPABASE_URL) +
                            "/rest/v1/devices?esp32_identifier=eq." +
                            String(GATE_ID);
          clearHttp.begin(secureClient, clearUrl);
          clearHttp.setTimeout(4000);
          clearHttp.addHeader("apikey", SUPABASE_ANON);
          clearHttp.addHeader("Authorization",
                              String("Bearer ") + SUPABASE_ANON);
          clearHttp.addHeader("Content-Type", "application/json");
          clearHttp.PATCH("{\"target_ssid\":null,\"target_pass\":null}");
          clearHttp.end();

          // Attempt connection to the new network
          bool ok = attemptWifiConnection(newSsid, newPass, 20);
          if (ok) {
            syncWhitelistToSD();
          } else {
            Serial.println("[REMOTE CMD] Failed to connect to new Wi-Fi. "
                           "Reconnecting to saved network...");
            attemptWifiConnection(currentSsid, currentPass, 15);
          }
          showReady();
          return;
        }
      }
    }
  }
  checkHttp.end();

  // 2. Report Live Online Status, Wi-Fi SSID, and IP Address to Cloud
  HTTPClient http;
  String url = String(SUPABASE_URL) + "/rest/v1/devices?esp32_identifier=eq." +
               String(GATE_ID);
  http.begin(secureClient, url);
  http.setTimeout(8000);
  http.addHeader("apikey", SUPABASE_ANON);
  http.addHeader("Authorization", String("Bearer ") + SUPABASE_ANON);
  http.addHeader("Content-Type", "application/json");
  http.addHeader("Prefer", "return=representation");

  String sdStat = sdCardReady ? "MOUNTED (HSPI)" : "UNMOUNTED / ERROR";
  String payload =
      "{\"status\":\"ONLINE\",\"last_online\":\"now()\",\"wifi_ssid\":\"" +
      WiFi.SSID() + "\",\"ip_address\":\"" + WiFi.localIP().toString() +
      "\",\"sd_status\":\"" + sdStat +
      "\",\"rfid_status\":\"MFRC522 READY\",\"led_status\":\"ACTIVE "
      "(🔴🟡🟢)\",\"buzzer_status\":\"PWM READY\",\"lcd_status\":\"INITIALIZED "
      "(16x2)\",\"relay_status\":\"ARMED\"}";
  int code = http.PATCH(payload);
  String patchResp = (code > 0) ? http.getString() : "";
  bool patched = (code >= 200 && code < 300 && patchResp != "[]");
  if (!patched) {
    http.end();
    String upsertUrl =
        String(SUPABASE_URL) + "/rest/v1/devices?on_conflict=esp32_identifier";
    http.begin(secureClient, upsertUrl);
    http.setTimeout(8000);
    http.addHeader("apikey", SUPABASE_ANON);
    http.addHeader("Authorization", String("Bearer ") + SUPABASE_ANON);
    http.addHeader("Content-Type", "application/json");
    http.addHeader("Prefer", "resolution=merge-duplicates,return=minimal");
    String fullPayload =
        "{\"esp32_identifier\":\"" + String(GATE_ID) + "\",\"device_name\":\"" +
        String(GATE_NAME) + "\",\"gate_type\":\"" + String(GATE_TYPE) +
        "\",\"device_category\":\"" + String(GATE_CATEGORY) +
        "\",\"rfid_range\":\"" + String(RFID_FREQUENCY) +
        "\",\"device_location\":\"" + String(GATE_LOCATION) +
        "\",\"status\":\"ONLINE\",\"last_online\":\"now()\",\"wifi_ssid\":\"" +
        WiFi.SSID() + "\",\"ip_address\":\"" + WiFi.localIP().toString() +
        "\",\"sd_status\":\"" + sdStat +
        "\",\"rfid_status\":\"MFRC522 READY\",\"led_status\":\"ACTIVE "
        "(🔴🟡🟢)\",\"buzzer_status\":\"PWM "
        "READY\",\"lcd_status\":\"INITIALIZED "
        "(16x2)\",\"relay_status\":\"ARMED\"}";
    http.POST(fullPayload);
  }
  http.end();
}

// =======================
// SD CARD: SAVE Wi-Fi BACKUP
// =======================
void saveWifiToSD(String ssid, String pass) {
  if (!sdCardReady)
    return;
  if (!SD.exists("/config"))
    SD.mkdir("/config");
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
  if (!sdCardReady || !SD.exists(WIFI_CONFIG_FILE))
    return false;
  File f = SD.open(WIFI_CONFIG_FILE, FILE_READ);
  if (!f)
    return false;
  outSsid = "";
  outPass = "";
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
    Serial.println("[WIFI SCAN] No networks found. (Make sure router is "
                   "broadcasting on 2.4GHz)");
  } else {
    Serial.println("[WIFI SCAN] Discovered " + String(n) + " network(s):");
    for (int i = 0; i < n; ++i) {
      String sec =
          (WiFi.encryptionType(i) == WIFI_AUTH_OPEN) ? "OPEN" : "SECURED";
      Serial.println("   [" + String(i + 1) + "] \"" + WiFi.SSID(i) +
                     "\" | RSSI: " + String(WiFi.RSSI(i)) + " dBm | " + sec);
    }
  }
  Serial.println();
}

// =====================================================
// BLUETOOTH LOW ENERGY (BLE) PROVISIONING SUBSYSTEM
// =====================================================
void sendBleStatus(String status) {
  if (pBleCharacteristic && bleClientConnected) {
    pBleCharacteristic->setValue(status.c_str());
    pBleCharacteristic->notify();
    Serial.println("[BLE TX NOTIFY] " + status);
  }
}

class BleServerCallbacks : public BLEServerCallbacks {
  void onConnect(BLEServer *pServer) {
    bleClientConnected = true;
    bleEvtConnected = true;
  }

  void onDisconnect(BLEServer *pServer) {
    bleClientConnected = false;
    bleEvtDisconnected = true;
  }
};

class BleCharCallbacks : public BLECharacteristicCallbacks {
  void onWrite(BLECharacteristic *pCharacteristic) {
    String rxValue = pCharacteristic->getValue().c_str();
    if (rxValue.length() > 0) {
      Serial.println("[BLE RX] Raw data: " + rxValue);
      DynamicJsonDocument doc(512);
      DeserializationError err = deserializeJson(doc, rxValue);
      String newSsid = "";
      String newPass = "";
      if (err == DeserializationError::Ok) {
        newSsid = String(doc["ssid"] | "");
        newPass = String(doc["pass"] | "");
      } else {
        int colon = rxValue.indexOf(':');
        int comma = rxValue.indexOf(',');
        if (colon != -1) {
          newSsid = rxValue.substring(0, colon);
          newPass = rxValue.substring(colon + 1);
        } else if (comma != -1) {
          newSsid = rxValue.substring(0, comma);
          newPass = rxValue.substring(comma + 1);
        } else {
          newSsid = rxValue;
        }
      }
      newSsid.trim();
      newPass.trim();

      if (newSsid.length() > 0 && !newWifiCredentialsReceived) {
        pendingBleSsid = newSsid;
        pendingBlePass = newPass;
        newWifiCredentialsReceived = true;
      }
    }
  }
};

void startBleServer() {
  if (bleServerRunning) {
    BLEDevice::startAdvertising();
    return;
  }

  Serial.println("[BLE] Initializing Bluetooth Provisioning Server (" +
                 String(BLE_DEVICE_NAME) + ")...");
  lcdMsg("BLE SETUP MODE", "PAIR ON WEB/APP");

  // Coexistence: Wi-Fi must be in modem-sleep before the BT controller starts
  esp_wifi_set_ps(WIFI_PS_MIN_MODEM);

  BLEDevice::init(BLE_DEVICE_NAME);
  BLEDevice::setMTU(517);
  pBleServer = BLEDevice::createServer();
  pBleServer->setCallbacks(new BleServerCallbacks());

  BLEService *pService = pBleServer->createService(BLE_SERVICE_UUID);
  pBleCharacteristic = pService->createCharacteristic(
      BLE_CHAR_UUID, BLECharacteristic::PROPERTY_READ |
                         BLECharacteristic::PROPERTY_WRITE |
                         BLECharacteristic::PROPERTY_WRITE_NR |
                         BLECharacteristic::PROPERTY_NOTIFY);

  pBleCharacteristic->setCallbacks(new BleCharCallbacks());
  pBleCharacteristic->addDescriptor(new BLE2902());
  pService->start();

  BLEAdvertising *pAdvertising = BLEDevice::getAdvertising();
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
  Serial.println("[BLE] >>> BROADCASTING AS '" + String(BLE_DEVICE_NAME) +
                 "' (Ready for Pairing) <<<");
}

void pauseBleAdvertising() {
  if (bleServerRunning) {
    BLEDevice::getAdvertising()->stop();
    Serial.println("[BLE] Wi-Fi connected! Paused BLE advertising.");
  }
}

// =======================
// WIFI CONNECTION & AUTO RECONNECT
// =======================
bool attemptWifiConnection(String testSsid, String testPass,
                           int timeoutSeconds) {
  if (testSsid.length() == 0)
    return false;

  Serial.println("\n===========================================");
  Serial.println("[WIFI] Target SSID: '" + testSsid +
                 "' (Max 3 Reconnect Attempts)");
  if (testPass.length() > 0) {
    Serial.println("[WIFI] Password:    [" + String(testPass.length()) +
                   " characters]");
  } else {
    Serial.println("[WIFI] Password:    (NONE / OPEN NETWORK)");
  }
  Serial.println("===========================================");

  // 1. Temporarily pause BLE advertising during Wi-Fi handshake to give radio
  // priority
  if (bleServerRunning) {
    BLEDevice::getAdvertising()->stop();
  }

  // Proper WiFi mode initialization
  WiFi.mode(WIFI_STA);
  applyWifiPowerSave();

  const int MAX_ATTEMPTS = 3;
  int perAttemptTimeout = (timeoutSeconds >= 15) ? (timeoutSeconds / 3 + 2)
                                                 : 7; // ~7 seconds per attempt

  for (int attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    Serial.printf("\n[WIFI] --> Attempt %d of %d to connect to '%s'...\n",
                  attempt, MAX_ATTEMPTS, testSsid.c_str());
    lcdMsg("WIFI CONNECT " + String(attempt) + "/3", testSsid.substring(0, 16));

    WiFi.disconnect();
    delay(200);

    if (testPass.length() > 0) {
      WiFi.begin(testSsid.c_str(), testPass.c_str());
    } else {
      WiFi.begin(testSsid.c_str(), NULL);
    }

    int elapsed = 0;
    while (WiFi.status() != WL_CONNECTED && elapsed < perAttemptTimeout * 2) {
      delay(500);
      Serial.print(".");
      elapsed++;

      if (WiFi.status() == WL_CONNECT_FAILED) {
        Serial.println("\n[WIFI ERROR] WL_CONNECT_FAILED (Code 4): Password "
                       "was rejected!");
        break;
      }
    }

    if (WiFi.status() == WL_CONNECTED) {
      // Wait for router DHCP to assign a valid non-zero IP address
      int dhcpWait = 0;
      while (WiFi.localIP() == IPAddress(0, 0, 0, 0) && dhcpWait < 20) {
        delay(250);
        dhcpWait++;
      }

      wifiConnected = true;
      WiFi.setSleep(false);
      esp_wifi_set_ps(WIFI_PS_NONE);
      if (WiFi.dnsIP() == IPAddress(0, 0, 0, 0)) {
        WiFi.setDNS(IPAddress(8, 8, 8, 8), IPAddress(1, 1, 1, 1));
      }
      configTime(0, 0, "pool.ntp.org",
                 "time.google.com"); // System clock for TLS

      Serial.println("\n[OK] WiFi Connected! IP: " + WiFi.localIP().toString() +
                     " | RSSI: " + String(WiFi.RSSI()) +
                     " dBm | DNS: " + WiFi.dnsIP().toString());
      lcdMsg("WiFi CONNECTED", WiFi.localIP().toString());
      signalWifiConnectedSuccess(); // 3 Green blinks, then Red Standby
      delay(400);

      lcdMsg("SAVING WI-FI...", "NVS & SD BACKUP");
      saveWifiToNVS(testSsid, testPass);
      saveWifiToSD(testSsid, testPass);
      currentSsid = testSsid;
      currentPass = testPass;
      delay(400);

      // Send positive acknowledgement to Web Bluetooth client
      sendBleStatus("{\"event\":\"CONNECTED\",\"ip\":\"" +
                    WiFi.localIP().toString() +
                    "\",\"rssi\":" + String(WiFi.RSSI()) + "}");
      pauseBleAdvertising();
      Serial.println("[WIFI] Stable connection established.");
      return true;
    }

    Serial.printf("\n[WIFI] Attempt %d/%d failed (Status: %d).\n", attempt,
                  MAX_ATTEMPTS, WiFi.status());
    if (attempt < MAX_ATTEMPTS) {
      lcdMsg("RETRYING WIFI...", String(attempt + 1) + " of 3");
      delay(800);
    }
  }

  // ── ALL 3 ATTEMPTS EXHAUSTED: Stop background loop & Open Bluetooth ──
  wifiConnected = false;
  int st = WiFi.status();
  String errDetail = "3 Attempts Timed Out";
  if (st == WL_NO_SSID_AVAIL) {
    errDetail = "SSID not found on 2.4GHz";
  } else if (st == WL_CONNECT_FAILED) {
    errDetail = "Password rejected";
  }

  Serial.println("\n[WIFI] ❌ 3 connection attempts failed. Halting Wi-Fi "
                 "background loop to free radio.");
  Serial.println("[BLE] >>> OPENING BLUETOOTH LOW ENERGY FOR PROVISIONING <<<");

  // CRITICAL: Stop background Wi-Fi reconnect attempts so 2.4GHz radio is 100%
  // free for BLE
  WiFi.setAutoReconnect(false);
  WiFi.disconnect(true);

  // LCD status updates so user sees what happened without IDE
  lcdMsg("WIFI FAILED 3/3", "BLUETOOTH OPEN");
  delay(1500);
  lcdMsg("BLE READY (PAIR)", "SD OFFLINE MODE");

  // Start BLE Server and advertise immediately for Web Bluetooth pairing
  startBleServer();
  BLEDevice::startAdvertising();

  // Send failure event over BLE if client was already paired
  String failPayload = "{\"event\":\"FAILED\",\"error\":\"" + errDetail +
                       "\",\"code\":" + String(st) + "}";
  sendBleStatus(failPayload);

  scanAndPrintNetworks();
  delay(500);
  return false;
}

// =======================
// SETUP
// =======================
void setup() {
  WRITE_PERI_REG(
      RTC_CNTL_BROWN_OUT_REG,
      0); // Prevent false brownout reboots during simultaneous WiFi TX + buzzer

  // Critical DRAM recovery: Release Classic-BT memory (~35KB DRAM) to heap
  // immediately on boot so mbedTLS has ample contiguous heap (>80KB MaxBlock)
  // for RSA/ECC BIGNUM TLS handshakes
  esp_bt_controller_mem_release(ESP_BT_MODE_CLASSIC_BT);

  secureClient.setInsecure(); // Supabase HTTPS without root cert bundle (saves
                              // 35KB RAM)
  secureClient.setHandshakeTimeout(
      8); // Cap TLS handshake to 8s (prevents 120s stall in ESP32 3.x)
  Serial.begin(115200);
  delay(500); // Allow UART, USB-to-Serial bridge, and power rail to stabilize
  Serial.println("\n==========================================");
  Serial.println("  CHARRMPASS — EXIT GATE (13.56 MHz HF)");
  Serial.println("==========================================\n");
  Serial.flush();

  Serial.println("[BOOT] Initializing I2C bus and LCD...");
  Wire.begin(21, 22);
  lcd.begin(16, 2);
  lcdMsg("  CHARRMPASS  ", "EXIT GATE HF");
  delay(1000);

  // 1. Initialize RFID on VSPI (Default SPI: SCK 18, MISO 19, MOSI 23, SS 5)
  SPI.begin();
  rfid.PCD_Init();
  rfid.PCD_SetAntennaGain(MFRC522::RxGain_max);
  Serial.println("[RFID] 13.56 MHz HF Initialized on VSPI (SS 5, SCK 18, MISO "
                 "19, MOSI 23)");

  // 1b. Allocate RAM cache dynamically on Heap (Eliminates .dram0.bss linker
  // overflow)
  ramWhitelist = (WhitelistCard *)calloc(MAX_RAM_CARDS, sizeof(WhitelistCard));
  ramInsideList =
      (InsideRecord *)calloc(MAX_INSIDE_RECORDS, sizeof(InsideRecord));
  if (ramWhitelist == NULL || ramInsideList == NULL) {
    Serial.println("[ERROR] Failed to allocate RAM cache memory!");
  } else {
    Serial.println("[BOOT] Dynamic RAM cache allocated successfully (" +
                   String(MAX_RAM_CARDS) + " cards).");
  }

  // 2. Initialize SD Card on dedicated HSPI Bus (SCK 26, MISO 14, MOSI 12, CS
  // 13)
  initSDCard();
  loadWhitelistFromSDToRAM();

  pinMode(RED_LED, OUTPUT);
  pinMode(YELLOW_LED, OUTPUT);
  pinMode(GREEN_LED, OUTPUT);
  pinMode(BUZZER_PIN, OUTPUT);
  pinMode(BOOT_BUTTON_PIN, INPUT_PULLUP);
  setTrafficLight(true, false, false); // Initial Standby: RED ON

  // 3. Load Saved Wi-Fi Credentials
  // Priority 1: NVS Flash
  preferences.begin("charrm_wifi", true);
  currentSsid = preferences.getString("ssid", "");
  currentPass = preferences.getString("pass", "");
  preferences.end();

  // Priority 2: SD Card Backup (/config/wifi.cfg) if NVS is empty
  if (currentSsid.length() == 0) {
    if (loadWifiFromSD(currentSsid, currentPass)) {
      Serial.println("[BOOT] Loaded Wi-Fi credentials from SD backup: '" +
                     currentSsid + "'");
    }
  }

  // Priority 3: Default code constants (DEFAULT_WIFI_SSID) if NVS & SD are
  // empty
  if (currentSsid.length() == 0 &&
      String(DEFAULT_WIFI_SSID) != "YOUR_WIFI_SSID" &&
      strlen(DEFAULT_WIFI_SSID) > 0) {
    currentSsid = DEFAULT_WIFI_SSID;
    currentPass = DEFAULT_WIFI_PASS;
    Serial.println(
        "[BOOT] Loaded default Wi-Fi credentials from firmware code.");
  }

  if (currentSsid.length() > 0) {
    Serial.println("[BOOT] Wi-Fi credentials found: '" + currentSsid +
                   "'. Attempting connection (3 tries max)...");
    bool wifiOk = attemptWifiConnection(currentSsid, currentPass, 18);
    if (!wifiOk) {
      Serial.println("[BOOT] Wi-Fi failed after 3 attempts. Operating in "
                     "Offline SD Cache Mode with BLE Open.");
    }
  } else {
    Serial.println(
        "[BOOT] No saved Wi-Fi credentials found in NVS, SD, or code.");
    Serial.println(
        "[BOOT] Starting BLE server for wireless Web provisioning...");
    startBleServer();
    lcdMsg("BLE SETUP MODE", "PAIR ON WEB/APP");
    scanAndPrintNetworks();
  }

  // Prioritize physical gate operation: Make turnstile ready immediately using
  // local RAM/SD cache!
  showReady();

  // If connected, sync database in the background without blocking gate
  // readiness
  if (wifiConnected && WiFi.status() == WL_CONNECTED) {
    Serial.println(
        "[BOOT] Gate is active. Starting initial cloud sync in background...");
    syncWhitelistToSD();
    syncOfflineTransactionsToCloud();
    sendDeviceHeartbeat();
    showReady();
  }
}

// =======================
// MAIN LOOP
// =======================
void loop() {
  // ── ONBOARD BOOT BUTTON (GPIO 0): Hold for 3s to force Wi-Fi reset & enter
  // BLE Setup Mode ──
  static unsigned long bootButtonPressStart = 0;
  if (digitalRead(BOOT_BUTTON_PIN) == LOW) {
    if (bootButtonPressStart == 0) {
      bootButtonPressStart = millis();
    } else if (millis() - bootButtonPressStart >= 3000) {
      Serial.println("\n🔘 [HARDWARE BUTTON] BOOT button held for 3s -> "
                     "Forcing Wi-Fi Reset & BLE Setup Mode!");
      lcdMsg("WIFI RESET", "BLE SETUP MODE");
      tone(BUZZER_PIN, 1800, 200);
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
      WiFi.disconnect(true);
      wifiConnected = false;
      startBleServer();
      showReady();
      bootButtonPressStart = 0;
      while (digitalRead(BOOT_BUTTON_PIN) == LOW) {
        delay(10);
      } // Wait for button release
    }
  } else {
    bootButtonPressStart = 0;
  }

  // ── BLE EVENTS (raised by BLE callbacks, handled safely here) ──
  if (bleEvtConnected) {
    bleEvtConnected = false;
    Serial.println("\n[BLE] Web Client Connected via Bluetooth!");
    lcdMsg("BLUETOOTH PAIRED", "WAITING WIFI...");
    tone(BUZZER_PIN, 2000, 100);
  }
  if (bleEvtDisconnected) {
    bleEvtDisconnected = false;
    Serial.println("[BLE] Web Client Disconnected.");
    // Only re-advertise if we still need provisioning (i.e. offline)
    if (bleServerRunning && !wifiConnected) {
      BLEDevice::startAdvertising();
      Serial.println("[BLE] Advertising resumed (device still offline).");
    }
    showReady();
  }

  // ── BLE PROVISIONING: Handle new Wi-Fi credentials received over Bluetooth
  // ──
  if (newWifiCredentialsReceived) {
    String newSsid = pendingBleSsid;
    String newPass = pendingBlePass;
    newWifiCredentialsReceived = false;

    Serial.println("\n[BLE PROVISION] Received SSID: '" + newSsid + "' (" +
                   String(newPass.length()) + " char password)");
    lcdMsg("RECEIVED WIFI", newSsid.substring(0, 16));
    tone(BUZZER_PIN, 2000, 150);
    sendBleStatus("{\"event\":\"SAVED\",\"ssid\":\"" + newSsid + "\"}");
    delay(300); // let notify reach browser before radio switches

    String prevSsid = currentSsid;
    String prevPass = currentPass;
    bool ok = attemptWifiConnection(newSsid, newPass, 25);
    if (!ok && prevSsid.length() > 0 && prevSsid != newSsid) {
      Serial.println(
          "[BLE PROVISION] New Wi-Fi failed. Restoring previous network '" +
          prevSsid + "'...");
      attemptWifiConnection(prevSsid, prevPass, 15);
    }
    showReady();
  }

  // Non-blocking ready reset timer
  if (isDisplayHolding && millis() >= readyResetTime) {
    isDisplayHolding = false;
    showReady();
  }

  // ── OFFLINE STATUS INDICATOR: Non-blocking blinking yellow LED ──
  // Blinks Yellow (500ms ON, 500ms OFF) when offline without blocking RFID
  // reads
  if (!isDisplayHolding && (!wifiConnected || WiFi.status() != WL_CONNECTED)) {
    static unsigned long lastOfflineBlink = 0;
    static bool offlineYellowState = true;
    if (millis() - lastOfflineBlink >= 500) {
      lastOfflineBlink = millis();
      offlineYellowState = !offlineYellowState;
      digitalWrite(RED_LED, LOW);
      digitalWrite(GREEN_LED, LOW);
      digitalWrite(YELLOW_LED, offlineYellowState ? HIGH : LOW);
    }
  }

  // WiFi Watchdog & Reconnection
  if (WiFi.status() != WL_CONNECTED) {
    if (wifiConnected) {
      wifiConnected = false;
      Serial.println("[WARN] WiFi lost — SD Fallback Mode Active (Blinking "
                     "YELLOW Standby)");
      startBleServer();
      showReady();
    } else if (!bleServerRunning) {
      startBleServer();
    }
  } else {
    if (!wifiConnected) {
      wifiConnected = true;
      WiFi.setSleep(false);
      esp_wifi_set_ps(WIFI_PS_NONE);
      if (WiFi.dnsIP() == IPAddress(0, 0, 0, 0)) {
        WiFi.setDNS(IPAddress(8, 8, 8, 8), IPAddress(1, 1, 1, 1));
      }
      configTime(0, 0, "pool.ntp.org", "time.google.com");
      Serial.println("[OK] WiFi Reconnected! Signaling 3 green blinks...");
      lcdMsg("WiFi RECONNECTED", WiFi.localIP().toString());
      pauseBleAdvertising();
      signalWifiConnectedSuccess(); // 3 Green blinks, then Standby RED
      delay(400);
      syncOfflineTransactionsToCloud();
      syncWhitelistToSD();
      sendDeviceHeartbeat();
      showReady();
    }
  }

  // Asynchronous Background Cloud Transaction Dispatch (Zero Turnstile Delay)
  processCloudQueue();

  // Periodic Heartbeat to Supabase (Every 60 seconds)
  static unsigned long lastHeartbeat = 0;
  if (wifiConnected && (millis() - lastHeartbeat > 60000)) {
    lastHeartbeat = millis();
    sendDeviceHeartbeat();
  }

  // Periodic Whitelist Sync when Online
  if (wifiConnected &&
      (millis() - lastWhitelistSync > WHITELIST_SYNC_INTERVAL)) {
    syncWhitelistToSD();
    showReady();
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

        Serial.println("\n[SERIAL PROVISION] Saving credentials for SSID: '" +
                       currentSsid + "'...");
        saveWifiToNVS(currentSsid, currentPass);
        saveWifiToSD(currentSsid, currentPass);
        lcdMsg("SAVED! RESTART", currentSsid.substring(0, 16));
        tone(BUZZER_PIN, 2200, 300);
        delay(600);
        ESP.restart();
        return;
      }

      // ── RESET: → Wipe NVS credentials and SD backup ──
      if (inputStr.equalsIgnoreCase("RESET:") ||
          inputStr.equalsIgnoreCase("RESET")) {
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
        Serial.println("[RESET] Wi-Fi credentials cleared from NVS & SD. "
                       "Operating in Offline SD Cache Mode.");
        lcdMsg("WIFI RESET", "SD OFFLINE MODE");
        tone(BUZZER_PIN, 500, 400);
        delay(500);
        WiFi.disconnect(true);
        wifiConnected = false;
        showReady();
        return;
      }

      // Guard RFID UID manual input
      String manualUid = inputStr;
      manualUid.toUpperCase();
      Serial.println("\n[MANUAL ENCODE] Guard entered UID: " + manualUid);
      tone(BUZZER_PIN, 1800, 100);
      processScan(manualUid);
      return;
    }
  }

  // 2. Physical Card Scan
  if (isDisplayHolding && millis() < readyResetTime)
    return;
  if (!rfid.PICC_IsNewCardPresent())
    return;
  if (!rfid.PICC_ReadCardSerial())
    return;

  if (millis() - lastScanTime < SCAN_COOLDOWN) {
    rfid.PICC_HaltA();
    return;
  }
  lastScanTime = millis();

  String uid = "";
  for (byte i = 0; i < rfid.uid.size; i++) {
    if (rfid.uid.uidByte[i] < 0x10)
      uid += "0";
    uid += String(rfid.uid.uidByte[i], HEX);
    if (i != rfid.uid.size - 1)
      uid += " ";
  }
  uid.toUpperCase();

  tone(BUZZER_PIN, 2000, 100);
  processScan(uid);
  rfid.PICC_HaltA();
}
