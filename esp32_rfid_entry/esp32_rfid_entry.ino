/*
 * ============================================================
 * CHARRMPASS — CLOSE-RANGE RFID PEDESTRIAN ENTRY GATE
 *
 * Dedicated Firmware for the PEDESTRIAN ENTRY TURNSTILE:
 *   - Operating Frequency: 13.56 MHz HF (MFRC522 / MIFARE / ISO 14443A)
 *   - Role: Dedicated Pedestrian Entry Turnstile (Separate Hardware Unit)
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

#define GATE_TYPE "ENTRY"
#define GATE_ID "CHARRMPASS_GATE_ENTRY"
#define GATE_NAME "CHARRMPASS Entry Unit"
#define GATE_CATEGORY "PEDESTRIAN (ENTRY)"
#define GATE_LOCATION "Pedestrian Entry Gate"
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
#include <esp_bt.h>   // for esp_bt_controller_mem_release()
#include <esp_wifi.h> // for esp_wifi_set_ps(WIFI_PS_NONE)
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
#define BLE_DEVICE_NAME "CHARRMPASS_ENTRY_BLE"

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

// 3. Peripherals — Traffic Light System (Red = Standby, Yellow = Scanning,
// Green = Done)
#define RED_LED 2     // Traffic Light: RED (Standby / Idle / Denied)
#define YELLOW_LED 25 // Traffic Light: YELLOW (Scanning / Processing Card)
#define GREEN_LED 4   // Traffic Light: GREEN (Done / Access Granted)
#define BUZZER_PIN 15 // Active Buzzer
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
bool bleStackInitialized = false;
bool bleClientConnected = false;
bool bleServerRunning = false;
bool inBleSetupMode = false; // When true, LCD stays in "BLE SETUP MODE" waiting for user to pair & configure Wi-Fi
volatile bool pendingForget = false; // Remote/BLE "forget Wi-Fi" request (handled safely in loop)
volatile bool newWifiCredentialsReceived = false;
String pendingBleSsid = "";
String pendingBlePass = "";
String bleRxBuffer = "";
unsigned long lastBleRxTime = 0;

// BLE callbacks run on the Bluetooth stack task. They only set flags; loop()
// handles LCD/buzzer.
volatile bool bleEvtConnected = false;
volatile bool bleEvtDisconnected = false;

// Coexistence: ESP32 shares ONE 2.4GHz radio between Wi-Fi and BLE.
// When BLE is active, Wi-Fi modem sleep is required by ESP-IDF to prevent panic.
void applyWifiPowerSave() {
  if (bleServerRunning || bleStackInitialized) {
    WiFi.setSleep(true);
    if (WiFi.status() == WL_CONNECTED) {
      esp_wifi_set_ps(WIFI_PS_MIN_MODEM);
    }
  } else {
    WiFi.setSleep(false);
    if (WiFi.status() == WL_CONNECTED) {
      esp_wifi_set_ps(WIFI_PS_NONE);
    }
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
  char ts[25]; // ISO-8601 UTC timestamp captured at scan time
};
#define MAX_TX_QUEUE 16
QueuedTransaction txQueue[MAX_TX_QUEUE];
int txQueueHead = 0;
int txQueueTail = 0;
int txQueueCount = 0;

// Last-known epoch time persisted in NVS so offline scans still get accurate timestamps
time_t savedEpoch = 0;

// Non-blocking gate hold timer
unsigned long readyResetTime = 0;
bool isDisplayHolding = false;

// =======================
// SD CARD & SCAN STATE
// =======================
bool sdCardReady = false;
const char *WHITELIST_FILE = "/authorized_cards.csv";
const char *OFFLINE_TXNS_FILE = "/offline_txns.csv";
const char *INSIDE_LIST_FILE = "/inside_list.txt";
const char *WIFI_CONFIG_FILE = "/wifi.cfg"; // SD Wi-Fi primary storage (also mirrors to /config/wifi.cfg)

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
void forgetWifiAndStartBle();
void checkRemoteWifiCommand();
bool attemptWifiConnection(String testSsid, String testPass,
                           int timeoutSeconds = 20);
void syncWhitelistToSD();
void loadWhitelistFromSDToRAM();
void showReadyNonBlocking(unsigned long holdMs);
void insertTransactionOnline(String uid, String status, String remarks);
void enqueueTransaction(String uid, String status, String remarks, String uType,
                        String rType, String vId, String uId);
void processCloudQueue();
void flushQueueToSD();
void sendTransactionToCloud(const QueuedTransaction &item);
bool checkAuthorizationFast(String uid);
bool checkDuplicateFast(String uid, String &conflictDetail);
void markInsideFast(String uid);
void clearInsideFast(String uid);
void syncInsideStatusFromCloud();
bool checkEntryConflictOnline(String uid, String &conflictDetail);

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
  if (inBleSetupMode) {
    if (bleClientConnected) {
      lcdMsg("BLUETOOTH PAIRED", "ENCODE SSID&PASS");
    } else {
      lcdMsg("BLE SETUP MODE", "PAIR ON WEB/APP");
    }
    setTrafficLight(false, true, false); // Standby Yellow indicates BLE setup mode
    return;
  }

  if (wifiConnected && WiFi.status() == WL_CONNECTED) {
    lcdMsg("  SCAN CARD   ", "ENTRY READY...");
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
  pinMode(SD_MISO_PIN, INPUT_PULLUP);
  pinMode(SD_MOSI_PIN, OUTPUT);
  digitalWrite(SD_MOSI_PIN, HIGH);

  Serial.print("[SD] Initializing SD Card on HSPI (CS 13, MOSI 12, MISO 14, "
               "SCK 26)... ");

  const uint32_t speeds[3] = {4000000, 1000000, 400000};
  sdCardReady = false;

  for (int attempt = 0; attempt < 3; attempt++) {
    SD.end();
    spiSD.end();
    delay(40);

    // Initialize dedicated HSPI bus for SD Card
    spiSD.begin(SD_SCK_PIN, SD_MISO_PIN, SD_MOSI_PIN, SD_CS_PIN);

    // Send 80+ clock cycles with CS HIGH & MOSI HIGH to force SD card into native SPI mode
    digitalWrite(SD_CS_PIN, HIGH);
    spiSD.beginTransaction(SPISettings(400000, MSBFIRST, SPI_MODE0));
    for (int i = 0; i < 12; i++) {
      spiSD.transfer(0xFF);
    }
    spiSD.endTransaction();
    delay(20);

    if (SD.begin(SD_CS_PIN, spiSD, speeds[attempt])) {
      sdCardReady = true;
      break;
    }
    delay(80);
  }

  if (sdCardReady) {
    Serial.println("OK! (SD Card Ready)");

    if (!SD.exists(WHITELIST_FILE)) {
      File f = SD.open(WHITELIST_FILE, FILE_WRITE);
      if (f) {
        f.println("UID,NAME,PLATE,ROLE");
        f.close();
      }
    }
  } else {
    Serial.println("FAILED! (Check SD module wiring/card)");
  }
}

// =======================
// SD CARD OFFLINE LOGGING
String currentIsoTimestampEntry(bool &approx) {
  approx = false;
  time_t now = time(nullptr);
  if (now > 1700000000) {
    struct tm tmv;
    gmtime_r(&now, &tmv);
    char buf[24];
    strftime(buf, sizeof(buf), "%Y-%m-%dT%H:%M:%SZ", &tmv);
    return String(buf);
  }
  if (savedEpoch > 1700000000) {
    approx = true;
    time_t est = savedEpoch + (time_t)(millis() / 1000);
    struct tm tmv;
    gmtime_r(&est, &tmv);
    char buf[24];
    strftime(buf, sizeof(buf), "%Y-%m-%dT%H:%M:%SZ", &tmv);
    return String(buf);
  }
  return "";
}

void persistEpochIfValidEntry() {
  static unsigned long lastPersist = 0;
  if (lastPersist != 0 && millis() - lastPersist < 300000UL)
    return;
  time_t now = time(nullptr);
  if (now < 1700000000)
    return;
  lastPersist = millis();
  preferences.begin("charrm_time", false);
  preferences.putULong("epoch", (unsigned long)now);
  preferences.end();
  savedEpoch = now - (time_t)(millis() / 1000);
}

String csvSafeEntry(String s) {
  s.replace(",", ";");
  s.replace("\r", " ");
  s.replace("\n", " ");
  return s;
}

// =======================
// SD CARD OFFLINE LOGGING
// Format: uid,direction,status,remarks,name,plate,isoTimestamp,userType,
//         rfidType,vehicleId,userId
// =======================
void saveOfflineTransactionFull(String uid, String status, String remarks,
                                String name, String plate, String uType,
                                String rType, String vId, String uId,
                                String ts) {
  if (!sdCardReady) {
    Serial.println("[SD] Cannot log offline scan: SD card not ready");
    return;
  }

  if (ts.length() == 0) {
    bool approx = false;
    ts = currentIsoTimestampEntry(approx);
    if (approx)
      remarks += " [approx time]";
  }

  File f = SD.open(OFFLINE_TXNS_FILE, FILE_APPEND);
  if (f) {
    f.print(csvSafeEntry(uid));
    f.print(",");
    f.print(GATE_TYPE);
    f.print(",");
    f.print(csvSafeEntry(status));
    f.print(",");
    f.print(csvSafeEntry(remarks));
    f.print(",");
    f.print(csvSafeEntry(name.length() > 0 ? name : String("Unknown")));
    f.print(",");
    f.print(csvSafeEntry(plate.length() > 0 ? plate : String("--")));
    f.print(",");
    f.print(ts);
    f.print(",");
    f.print(csvSafeEntry(uType));
    f.print(",");
    f.print(csvSafeEntry(rType));
    f.print(",");
    f.print(csvSafeEntry(vId));
    f.print(",");
    f.println(csvSafeEntry(uId));
    f.close();
    Serial.println("[SD] Logged offline transaction for " + uid + " @ " + ts);
  }
}

void saveOfflineTransaction(String uid, String status, String remarks) {
  saveOfflineTransactionFull(uid, status, remarks, card_name, card_plate,
                             card_userType, card_rfidType, card_vehicleId,
                             card_userId, "");
}

// =======================
// SD & RAM WHITELIST CACHE (Download & Store)
// =======================
void loadWhitelistFromSDToRAM() {
  ramWhitelistCount = 0;
  if (ramWhitelist == NULL) {
    ramWhitelist = (WhitelistCard *)calloc(MAX_RAM_CARDS, sizeof(WhitelistCard));
  }
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
                 " cards from SD into fast RAM (ENTRY).");
  lcdMsg("SD CACHE READY", String(ramWhitelistCount) + " CARDS IN RAM");
  delay(300);
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
      return;
    }
  }
}

void syncInsideStatusFromCloud() {
  // Deprecated: 30s local anti-passback debounce does not require cloud inside seeding
}

void syncWhitelistToSD() {
  if (!wifiConnected || WiFi.status() != WL_CONNECTED || !sdCardReady)
    return;

  Serial.println("\n[SD & RAM SYNC] Starting fast paginated whitelist sync "
                 "from Supabase (ENTRY)...");
  lcdMsg("SYNCING DATABASE", "CONNECTING...");

  // Release any idle TLS session + temporarily free 18.6KB ramWhitelist buffer
  // so mbedTLS and HTTPClient have ~75KB+ of contiguous heap during sync!
  secureClient.stop();
  if (ramWhitelist != NULL) {
    free(ramWhitelist);
    ramWhitelist = NULL;
  }
  ramWhitelistCount = 0;

  const char *TEMP_WHITELIST = "/auth_cards.tmp";
  if (SD.exists(TEMP_WHITELIST)) {
    SD.remove(TEMP_WHITELIST);
  }

  int totalSynced = 0;
  int offset = 0;
  const int BATCH_SIZE = 5; // Small 5-card pages (~1.1KB) fit in a single TCP segment & TLS record
  bool syncSuccess = true;

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
      secureClient.stop();
      secureClient.setInsecure();
      secureClient.setHandshakeTimeout(8);

      HTTPClient http;
      http.useHTTP10(true); // Avoid HTTP/1.1 chunked encoding mid-stream truncation
      http.begin(secureClient, url);
      http.setTimeout(8000);
      http.addHeader("apikey", SUPABASE_ANON);
      http.addHeader("Authorization", String("Bearer ") + SUPABASE_ANON);

      code = http.GET();
      if (code == 200) {
        body = http.getString();
        http.end();
        secureClient.stop(); // Free ~36KB mbedTLS buffers immediately before JSON parse!
        body.trim();
        if (body.startsWith("[") && body.endsWith("]")) {
          break;
        }
        Serial.printf("[SD SYNC] Incomplete payload (%d bytes) at offset %d, retrying (%d/%d)...\n",
                      body.length(), offset, retry, MAX_PAGE_RETRIES);
        code = -1;
      } else {
        char sslErr[128] = {0};
        int sslCode = secureClient.lastError(sslErr, sizeof(sslErr));
        String errStr = http.errorToString(code);
        http.end();
        secureClient.stop();
        Serial.printf(
            "[SD SYNC] Page fetch attempt %d/%d failed at offset %d (HTTP %d: %s "
            "| SSL %d: %s | FreeHeap: %d / MaxBlock: %d)\n",
            retry, MAX_PAGE_RETRIES, offset, code, errStr.c_str(), sslCode,
            sslErr, ESP.getFreeHeap(), ESP.getMaxAllocHeap());
      }
      if (retry < MAX_PAGE_RETRIES) {
        lcdMsg("DB RETRY " + String(retry + 1) + "/3", "WAITING RETRY");
        delay(600);
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

    DynamicJsonDocument doc(4096);
    DeserializationError jsonErr = deserializeJson(doc, body);
    body = ""; // Free raw string immediately after parsing
    if (jsonErr) {
      Serial.printf("[SD SYNC ERROR] deserializeJson failed at offset %d: %s "
                    "(Heap: %d / MaxBlock: %d)\n",
                    offset, jsonErr.c_str(), ESP.getFreeHeap(), ESP.getMaxAllocHeap());
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
        totalSynced++;
      }
      f.close();
    }

    offset += countInPage;
    lcdMsg("SYNCING DATABASE", "CACHED: " + String(totalSynced) + " CARDS");
    if (countInPage < BATCH_SIZE) {
      break; // Last page reached
    }
    delay(60);
  }

  // Also cache special tags (Emergency & Visitor passes) into SD
  if (syncSuccess) {
    lcdMsg("SYNCING DATABASE", "VISITOR PASSES..");
    String specialUrl =
        String(SUPABASE_URL) +
        "/rest/v1/special_tags?select=rfid_uid,type,label,description";
    secureClient.stop();
    secureClient.setInsecure();
    secureClient.setHandshakeTimeout(8);

    HTTPClient httpSpec;
    httpSpec.useHTTP10(true);
    httpSpec.begin(secureClient, specialUrl);
    httpSpec.setTimeout(5000);
    httpSpec.addHeader("apikey", SUPABASE_ANON);
    httpSpec.addHeader("Authorization", String("Bearer ") + SUPABASE_ANON);
    int specCode = httpSpec.GET();
    String specBody = "";
    if (specCode == 200) {
      specBody = httpSpec.getString();
    }
    httpSpec.end();
    secureClient.stop();

    if (specCode == 200 && specBody.length() > 0) {
      DynamicJsonDocument specDoc(3072);
      if (deserializeJson(specDoc, specBody) == DeserializationError::Ok) {
        JsonArray specArr = specDoc.as<JsonArray>();
        File fSpec = SD.open(TEMP_WHITELIST, totalSynced == 0 ? FILE_WRITE : FILE_APPEND);
        if (fSpec && totalSynced == 0) {
          fSpec.println("UID,NAME,PLATE,ROLE,USER_TYPE,RFID_TYPE,VEHICLE_ID,USER_ID");
        }
        int specAdded = 0;
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
          totalSynced++;
          specAdded++;
        }
        if (fSpec)
          fSpec.close();
        Serial.printf("[SD & RAM SYNC] Added %d special tags.\n", specAdded);
      }
    }
  }

  if (syncSuccess && totalSynced > 0) {
    SD.remove(WHITELIST_FILE);
    SD.rename(TEMP_WHITELIST, WHITELIST_FILE);
    loadWhitelistFromSDToRAM();
    Serial.printf("[SD & RAM SYNC] SUCCESS! Saved %d cards to SD (%s) and "
                  "loaded %d into RAM (ENTRY).\n",
                  totalSynced, WHITELIST_FILE, ramWhitelistCount);
    lcdMsg("DB SYNC SUCCESS", String(totalSynced) + " CARDS READY");
    delay(800);
  } else {
    SD.remove(TEMP_WHITELIST);
    Serial.println("[SD & RAM SYNC] Sync encountered an issue. Retaining "
                   "existing SD cache.");
    lcdMsg("DB SYNC ISSUE", "USING SD CACHE");
    delay(800);
    loadWhitelistFromSDToRAM();
  }

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

int splitCsvLineEntry(const String &line, String *out, int maxFields) {
  int n = 0, start = 0;
  while (n < maxFields - 1) {
    int i = line.indexOf(',', start);
    if (i < 0)
      break;
    out[n++] = line.substring(start, i);
    start = i + 1;
  }
  out[n++] = line.substring(start);
  return n;
}

// =======================
// AUTO-SYNC OFFLINE TRANSACTIONS TO CLOUD
// =======================
void syncOfflineTransactionsToCloud() {
  if (!wifiConnected || WiFi.status() != WL_CONNECTED || !sdCardReady ||
      !SD.exists(OFFLINE_TXNS_FILE))
    return;

  // 1. Read all offline lines into memory and CLOSE the SD file BEFORE opening TLS!
  File f = SD.open(OFFLINE_TXNS_FILE, FILE_READ);
  if (!f || f.size() == 0) {
    if (f)
      f.close();
    return;
  }

  const int MAX_SYNC_LINES = 40;
  String lines[MAX_SYNC_LINES];
  int totalLines = 0;
  String overflowLines = "";

  while (f.available()) {
    String l = f.readStringUntil('\n');
    l.trim();
    if (l.length() == 0)
      continue;
    if (totalLines < MAX_SYNC_LINES) {
      lines[totalLines++] = l;
    } else {
      overflowLines += l + "\n";
    }
  }
  f.close(); // Close SD file before TLS handshake!

  if (totalLines == 0) {
    SD.remove(OFFLINE_TXNS_FILE);
    return;
  }

  Serial.printf("[SYNC] Found %d offline transactions. Syncing to Supabase...\n", totalLines);
  lcdMsg("SYNCING LOGS...", "Please wait...");

  // Temporarily free ramWhitelist (18.6KB) so mbedTLS has ~75KB+ free heap for POST handshakes
  secureClient.stop();
  bool hadRamWhitelist = (ramWhitelist != NULL);
  if (ramWhitelist != NULL) {
    free(ramWhitelist);
    ramWhitelist = NULL;
    ramWhitelistCount = 0;
  }

  int syncedCount = 0, keptCount = 0, droppedCount = 0;
  bool abortSync = false;
  String remainingContent = "";

  for (int idx = 0; idx < totalLines; idx++) {
    String &line = lines[idx];
    String p[11];
    int n = splitCsvLineEntry(line, p, 11);
    if (n < 3) {
      droppedCount++;
      continue;
    }

    bool sent = false;
    bool permanentFail = false;

    if (!abortSync && wifiConnected && WiFi.status() == WL_CONNECTED) {
      secureClient.stop();
      secureClient.setInsecure();
      secureClient.setHandshakeTimeout(8);

      String url = String(SUPABASE_URL) + "/rest/v1/transactions";
      HTTPClient http;
      http.begin(secureClient, url);
      http.setTimeout(5000);
      http.addHeader("Content-Type", "application/json");
      http.addHeader("apikey", SUPABASE_ANON);
      http.addHeader("Authorization", String("Bearer ") + SUPABASE_ANON);
      http.addHeader("Prefer", "return=minimal");

      DynamicJsonDocument doc(640);
      doc["rfid_uid"] = p[0];
      doc["direction"] = p[1];
      doc["gate"] = GATE_ID;
      doc["status"] = p[2];
      String remarks = "[OFFLINE SYNC] " + (n > 3 ? p[3] : String(""));
      if (n < 11 && n > 5)
        remarks += " (" + p[4] + " / " + p[5] + ")";
      doc["remarks"] = remarks;
      // Preserve ORIGINAL scan timestamp so offline Entry -> Exit order is exact!
      if (n > 6 && p[6].length() >= 19)
        doc["timestamp"] = p[6];
      if (n >= 11) {
        if (p[7] == "PEDESTRIAN" || p[7] == "VEHICLE")
          doc["user_type"] = p[7];
        if (p[8] == "CLOSE_RANGE" || p[8] == "LONG_RANGE")
          doc["rfid_type"] = p[8];
        if (p[9].length() > 0 && p[9] != "null" && p[9] != "--")
          doc["vehicle_id"] = p[9];
        if (p[10].length() > 0 && p[10] != "null" && p[10] != "--")
          doc["user_id"] = p[10];
      }

      String body;
      serializeJson(doc, body);
      int code = http.POST(body);
      http.end();
      secureClient.stop();

      if (code >= 200 && code < 300) {
        sent = true;
        Serial.printf("[SYNC] Synced offline record %d/%d (%s) -> HTTP %d\n",
                      idx + 1, totalLines, p[0].c_str(), code);
      } else if (code >= 400 && code < 500 && code != 408 && code != 429) {
        permanentFail = true;
        Serial.printf("[SYNC] Dropping rejected record (HTTP %d): %s\n", code,
                      line.c_str());
      } else {
        Serial.printf("[SYNC] Temporary POST error (HTTP %d) on record %d/%d, keeping for retry.\n",
                      code, idx + 1, totalLines);
        abortSync = true;
      }
      delay(50);
    } else {
      abortSync = true;
    }

    if (sent) {
      syncedCount++;
    } else if (permanentFail) {
      droppedCount++;
    } else {
      remainingContent += line + "\n";
      keptCount++;
    }
    lines[idx] = "";
  }

  if (overflowLines.length() > 0) {
    remainingContent += overflowLines;
  }

  // Write back any unsent lines AFTER TLS is completely closed
  SD.remove(OFFLINE_TXNS_FILE);
  if (remainingContent.length() > 0) {
    File keep = SD.open(OFFLINE_TXNS_FILE, FILE_WRITE);
    if (keep) {
      keep.print(remainingContent);
      keep.close();
    }
  }

  if (hadRamWhitelist) {
    loadWhitelistFromSDToRAM();
  }

  Serial.printf("[SYNC] Synced %d, kept %d for retry, dropped %d.\n",
                syncedCount, keptCount, droppedCount);
  lcdMsg("SYNC COMPLETE", String(syncedCount) + " scans stored");
  delay(1200);
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
  secureClient.stop();
  String specialUrl = String(SUPABASE_URL) +
                      "/rest/v1/special_tags?rfid_uid=eq." + urlEncode(uid) +
                      "&select=type,label,description";
  HTTPClient httpSpec;
  httpSpec.useHTTP10(true);
  httpSpec.begin(secureClient, specialUrl);
  httpSpec.setTimeout(4000);
  httpSpec.addHeader("apikey", SUPABASE_ANON);
  httpSpec.addHeader("Authorization", String("Bearer ") + SUPABASE_ANON);
  int specCode = httpSpec.GET();
  String specBody = (specCode == 200) ? httpSpec.getString() : "";
  httpSpec.end();
  secureClient.stop();

  if (specCode == 200 && specBody.length() > 0) {
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
        return true;
      }
    }
  }

  // 2. Check registered users & vehicles
  String url =
      String(SUPABASE_URL) + "/rest/v1/rfid_cards?rfid_uid=eq." +
      urlEncode(uid) +
      "&select=authorization_status,vehicle_id,user_id,rfid_type,user_type,"
      "vehicles(plate_number,vehicle_type),"
      "users(full_name,role,default_transit_mode)";

  HTTPClient http;
  http.useHTTP10(true);
  http.begin(secureClient, url);
  http.setTimeout(4000);
  http.addHeader("apikey", SUPABASE_ANON);
  http.addHeader("Authorization", String("Bearer ") + SUPABASE_ANON);

  int code = http.GET();
  String body = "";
  if (code == 200) {
    body = http.getString();
  } else {
    http.end();
    secureClient.stop();
    return false;
  }
  http.end();
  secureClient.stop();

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

void enqueueTransaction(String uid, String status, String remarks, String uType,
                        String rType, String vId, String uId) {
  if (txQueueCount >= MAX_TX_QUEUE) {
    // Spill oldest to SD offline log to prevent buffer drop
    QueuedTransaction &old = txQueue[txQueueHead];
    saveOfflineTransactionFull(String(old.uid), String(old.status),
                               String(old.remarks), "", "",
                               String(old.userType), String(old.rfidType),
                               String(old.vehicleId), String(old.userId),
                               String(old.ts));
    txQueueHead = (txQueueHead + 1) % MAX_TX_QUEUE;
    txQueueCount--;
  }

  QueuedTransaction &item = txQueue[txQueueTail];
  memset(&item, 0, sizeof(QueuedTransaction));
  {
    bool approx = false;
    String ts = currentIsoTimestampEntry(approx);
    strncpy(item.ts, ts.c_str(), sizeof(item.ts) - 1);
  }
  strncpy(item.uid, uid.c_str(), sizeof(item.uid) - 1);
  strncpy(item.status, status.c_str(), sizeof(item.status) - 1);
  strncpy(item.remarks, remarks.c_str(), sizeof(item.remarks) - 1);
  strncpy(item.userType, uType.c_str(), sizeof(item.userType) - 1);
  strncpy(item.rfidType, rType.c_str(), sizeof(item.rfidType) - 1);
  strncpy(item.vehicleId, vId.c_str(), sizeof(item.vehicleId) - 1);
  strncpy(item.userId, uId.c_str(), sizeof(item.userId) - 1);

  txQueueTail = (txQueueTail + 1) % MAX_TX_QUEUE;
  txQueueCount++;
  Serial.printf("[QUEUE] Transaction queued for UID %s (%s). Queue depth: %d\n",
                uid.c_str(), status.c_str(), txQueueCount);
}

void sendTransactionToCloud(const QueuedTransaction &item) {
  if (!wifiConnected || WiFi.status() != WL_CONNECTED) {
    saveOfflineTransactionFull(String(item.uid), String(item.status),
                               String(item.remarks), "", "",
                               String(item.userType), String(item.rfidType),
                               String(item.vehicleId), String(item.userId),
                               String(item.ts));
    return;
  }

  secureClient.stop();
  String url = String(SUPABASE_URL) + "/rest/v1/transactions";
  HTTPClient http;
  http.begin(secureClient, url);
  http.setTimeout(3500);
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
  http.end();
  secureClient.stop();

  if (code >= 200 && code < 300) {
    Serial.printf("[SUPABASE CLOUD] Synced %s (%s) successfully.\n", item.uid,
                  item.status);
  } else {
    Serial.printf("[SUPABASE POST ERROR] HTTP %d. Storing to SD offline log.\n",
                  code);
    saveOfflineTransactionFull(String(item.uid), String(item.status),
                               String(item.remarks), "", "",
                               String(item.userType), String(item.rfidType),
                               String(item.vehicleId), String(item.userId),
                               String(item.ts));
  }
}

void flushQueueToSD() {
  while (txQueueCount > 0) {
    QueuedTransaction &it = txQueue[txQueueHead];
    saveOfflineTransactionFull(String(it.uid), String(it.status),
                               String(it.remarks), "", "", String(it.userType),
                               String(it.rfidType), String(it.vehicleId),
                               String(it.userId), String(it.ts));
    txQueueHead = (txQueueHead + 1) % MAX_TX_QUEUE;
    txQueueCount--;
  }
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

void insertTransactionOnline(String uid, String status, String remarks) {
  if (wifiConnected) {
    enqueueTransaction(uid, status, remarks, card_userType, card_rfidType,
                       card_vehicleId, card_userId);
  } else {
    saveOfflineTransaction(uid, status, remarks);
  }
}

// =======================
// ONLINE DUPLICATE ENTRY CHECK (Background helper only)
// =======================
bool checkDuplicateEntryOnline(String uid, String &conflictDetail) {
  String url = String(SUPABASE_URL) + "/rest/v1/transactions?rfid_uid=eq." +
               urlEncode(uid) +
               "&status=eq.AUTHORIZED&order=timestamp.desc&limit=1&select="
               "direction,timestamp";

  HTTPClient http;
  http.begin(secureClient, url);
  http.setTimeout(2500);
  http.addHeader("apikey", SUPABASE_ANON);
  http.addHeader("Authorization", String("Bearer ") + SUPABASE_ANON);

  int code = http.GET();
  String body = "";
  if (code == 200)
    body = http.getString();
  http.end();

  if (body.length() == 0 || body == "[]")
    return false;

  DynamicJsonDocument doc(512);
  if (deserializeJson(doc, body) == DeserializationError::Ok) {
    JsonArray arr = doc.as<JsonArray>();
    if (arr.size() > 0) {
      String lastDir = String(arr[0]["direction"] | "");
      String lastTs = String(arr[0]["timestamp"] | "");
      if (lastDir == "ENTRY") {
        if (lastTs.length() >= 16) {
          conflictDetail =
              "IN: " + lastTs.substring(11, 16) + " " + lastTs.substring(5, 10);
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
// FAST LOCAL VERIFICATION & ANTI-PASSBACK
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

  // 3. Fallback to single Cloud lookup only if Wi-Fi connected and not in local cache
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

bool checkDuplicateFast(String uid, String &conflictDetail) {
  if (ramInsideList == NULL)
    return false;
  String cleanUid = uid;
  cleanUid.replace(" ", "");
  cleanUid.toUpperCase();

  for (int i = 0; i < ramInsideCount; i++) {
    String inUid = String(ramInsideList[i].uid);
    inUid.replace(" ", "");
    inUid.toUpperCase();
    if (inUid == cleanUid) {
      unsigned long elapsedSec = (millis() - ramInsideList[i].timestamp) / 1000;
      // 30-second Transit Anti-Passback Debounce:
      // Suppress duplicate scans if card was already granted entry less than 30 seconds ago
      if (elapsedSec < 30) {
        conflictDetail = "Wait " + String(30 - elapsedSec) + "s";
        return true;
      }
      return false; // Valid entry if more than 30 seconds have elapsed
    }
  }
  return false;
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

// =======================
// ONLINE DOUBLE ENTRY / PRIOR STATE CHECK
// =======================
bool checkEntryConflictOnline(String uid, String &conflictDetail) {
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
    return false; // No previous history -> valid initial entry
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

      if (lastDir == "ENTRY") {
        conflictDetail = "IN: " + timeStr;
        return true;
      }
    }
  }
  return false;
}

void showReadyNonBlocking(unsigned long holdMs) {
  readyResetTime = millis() + holdMs;
  isDisplayHolding = true;
}

// =======================
// PROCESS SCAN (Ultra-Fast Sub-50ms Local-First Engine)
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

  // 2. Fast In-Memory Duplicate Check (< 0.01ms)
  if (card_role != "EMERGENCY") {
    String conflictDetail = "";
    bool isDuplicate = checkDuplicateFast(uid, conflictDetail);

    if (isDuplicate) {
      Serial.println("[RESULT] ENTRY DENIED — ALREADY INSIDE (" + conflictDetail + ")");
      lcdMsg("ALREADY INSIDE", conflictDetail);
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
            "Passback violation: ALREADY INSIDE (" + conflictDetail + ")",
            card_userType, card_rfidType, card_vehicleId, card_userId);
      } else {
        saveOfflineTransaction(uid, "DENIED",
                               "Passback violation: ALREADY INSIDE (" +
                                   conflictDetail + ")");
      }
      showReadyNonBlocking(1400);
      return;
    }
  }

  // 3. INSTANT AUTHORIZATION (Traffic Light: DONE = GREEN ON)
  markInsideFast(uid);
  Serial.println("[RESULT] AUTHORIZED ENTRY (Instant) — " + card_name);
  String plateLine =
      (card_plate.length() > 0 && card_plate != "--")
          ? card_plate
          : (card_name.length() > 0 ? card_name : uid.substring(0, 16));

  lcdMsg("ENTRY GRANTED", plateLine);
  tone(BUZZER_PIN, 2000, 100);
  delay(50);
  tone(BUZZER_PIN, 2500, 120);

  // Traffic Light: DONE = GREEN ON, YELLOW OFF, RED OFF
  setTrafficLight(false, false, true);

  String remarks = "ENTRY gate scan (Instant Fast Cache)";
  if (card_role == "EMERGENCY") {
    remarks = "Emergency tag: " +
              (card_name.length() > 0 ? card_name : "Emergency Response");
  } else if (card_role == "VISITOR") {
    remarks =
        "Visitor Entry: " + (card_name.length() > 0 ? card_name : "Visitor") +
        " | Plate: " + card_plate;
  }

  // 4. Zero-delay Asynchronous Queue (Enqueued in < 1us)
  if (wifiConnected) {
    enqueueTransaction(uid, "AUTHORIZED", remarks, card_userType, card_rfidType,
                       card_vehicleId, card_userId);
  } else {
    saveOfflineTransaction(uid, "AUTHORIZED", remarks);
  }

  // Return to ready display after non-blocking 0.9s window (never gets stuck on entered name!)
  showReadyNonBlocking(900);
}

// =======================
// DEVICE HEARTBEAT & OVER-THE-AIR WI-FI CONTROL
// =======================
String epochToIsoEntry(time_t t) {
  struct tm tmv;
  gmtime_r(&t, &tmv);
  char buf[24];
  strftime(buf, sizeof(buf), "%Y-%m-%dT%H:%M:%SZ", &tmv);
  return String(buf);
}

// Fast poll for remote "Forget Wi-Fi" command from Admin Dashboard
void checkRemoteWifiCommand() {
  if (!wifiConnected || WiFi.status() != WL_CONNECTED)
    return;

  HTTPClient checkHttp;
  String checkUrl = String(SUPABASE_URL) +
                    "/rest/v1/devices?esp32_identifier=eq." + String(GATE_ID) +
                    "&select=target_ssid,target_pass";
  checkHttp.begin(secureClient, checkUrl);
  checkHttp.setTimeout(2500);
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
          Serial.println("\n🌐 [REMOTE CLOUD CMD] Received Wi-Fi Reset / Provisioning command: '" +
                         newSsid + "'");
          lcdMsg("REMOTE CMD", "FORGETTING WIFI");

          checkHttp.end();
          secureClient.stop();

          // Acknowledge and clear target_ssid in Supabase immediately
          HTTPClient clearHttp;
          String clearUrl = String(SUPABASE_URL) +
                            "/rest/v1/devices?esp32_identifier=eq." +
                            String(GATE_ID);
          clearHttp.begin(secureClient, clearUrl);
          clearHttp.setTimeout(3000);
          clearHttp.addHeader("apikey", SUPABASE_ANON);
          clearHttp.addHeader("Authorization",
                              String("Bearer ") + SUPABASE_ANON);
          clearHttp.addHeader("Content-Type", "application/json");
          clearHttp.PATCH("{\"target_ssid\":null,\"target_pass\":null,\"status\":\"OFFLINE\",\"wifi_ssid\":\"BLE SETUP MODE\"}");
          clearHttp.end();
          secureClient.stop();

          // Trigger forget Wi-Fi -> open BLE setup mode in loop()
          pendingForget = true;
          return;
        }
      }
    }
  }
  checkHttp.end();
  secureClient.stop();
}

void sendDeviceHeartbeat() {
  if (WiFi.status() != WL_CONNECTED)
    return;

  // 1. Check for Over-The-Air Wi-Fi Reconfiguration Commands first
  checkRemoteWifiCommand();
  if (pendingForget)
    return;

  // 2. Report Live Online Status, Wi-Fi SSID, and IP Address to Cloud
  HTTPClient http;
  String url = String(SUPABASE_URL) + "/rest/v1/devices?esp32_identifier=eq." +
               String(GATE_ID);
  http.begin(secureClient, url);
  http.setTimeout(4000);
  http.addHeader("apikey", SUPABASE_ANON);
  http.addHeader("Authorization", String("Bearer ") + SUPABASE_ANON);
  http.addHeader("Content-Type", "application/json");

  String sdStat = sdCardReady ? "MOUNTED (HSPI)" : "UNMOUNTED / ERROR";
  String payload =
      "{\"status\":\"ONLINE\",\"last_online\":\"now()\",\"wifi_ssid\":\"" +
      WiFi.SSID() + "\",\"ip_address\":\"" + WiFi.localIP().toString() +
      "\",\"sd_status\":\"" + sdStat +
      "\",\"rfid_status\":\"MFRC522 READY\",\"led_status\":\"ACTIVE (🔴🟡🟢)\",\"buzzer_status\":\"PWM READY\",\"lcd_status\":\"INITIALIZED (16x2)\",\"relay_status\":\"ARMED\"}";
  int code = http.PATCH(payload);
  if (code < 200 || code >= 300) {
    http.end();
    secureClient.stop();
    String upsertUrl =
        String(SUPABASE_URL) + "/rest/v1/devices?on_conflict=esp32_identifier";
    http.begin(secureClient, upsertUrl);
    http.setTimeout(4000);
    http.addHeader("apikey", SUPABASE_ANON);
    http.addHeader("Authorization", String("Bearer ") + SUPABASE_ANON);
    http.addHeader("Content-Type", "application/json");
    http.addHeader("Prefer", "resolution=merge-duplicates,return=minimal");
    String fullPayload =
        "{\"esp32_identifier\":\"" + String(GATE_ID) + "\",\"device_name\":\"" +
        String(GATE_NAME) + "\",\"gate_type\":\"ENTRY" +
        "\",\"device_category\":\"" + String(GATE_CATEGORY) +
        "\",\"rfid_range\":\"" + String(RFID_FREQUENCY) +
        "\",\"device_location\":\"" + String(GATE_LOCATION) +
        "\",\"status\":\"ONLINE\",\"last_online\":\"now()\",\"wifi_ssid\":\"" +
        WiFi.SSID() + "\",\"ip_address\":\"" + WiFi.localIP().toString() +
        "\",\"sd_status\":\"" + sdStat +
        "\",\"rfid_status\":\"MFRC522 READY\",\"led_status\":\"ACTIVE (🔴🟡🟢)\",\"buzzer_status\":\"PWM READY\",\"lcd_status\":\"INITIALIZED (16x2)\",\"relay_status\":\"ARMED\"}";
    http.POST(fullPayload);
  }
  http.end();
  secureClient.stop();
}

// =======================
// SD CARD: SAVE Wi-Fi CREDENTIALS
// =======================
void saveWifiToSD(String ssid, String pass) {
  if (!sdCardReady) {
    initSDCard();
  }
  if (!sdCardReady) {
    Serial.println("[SD] Cannot save Wi-Fi to SD: SD card not ready!");
    return;
  }

  // 1. Save to primary root file (/wifi.cfg)
  if (SD.exists(WIFI_CONFIG_FILE)) {
    SD.remove(WIFI_CONFIG_FILE);
  }
  File f = SD.open(WIFI_CONFIG_FILE, FILE_WRITE);
  if (f) {
    f.println("SSID=" + ssid);
    f.println("PASSWORD=" + pass);
    f.flush();
    f.close();
    Serial.println("[SD] Wi-Fi credentials saved to SD card (" +
                   String(WIFI_CONFIG_FILE) + ") for SSID: '" + ssid + "'");
  } else {
    Serial.println("[SD] ERROR: Could not write Wi-Fi credentials to " +
                   String(WIFI_CONFIG_FILE));
  }

  // 2. Mirror to /config/wifi.cfg for backwards compatibility
  if (!SD.exists("/config")) {
    SD.mkdir("/config");
  }
  if (SD.exists("/config/wifi.cfg")) {
    SD.remove("/config/wifi.cfg");
  }
  File f2 = SD.open("/config/wifi.cfg", FILE_WRITE);
  if (f2) {
    f2.println("SSID=" + ssid);
    f2.println("PASSWORD=" + pass);
    f2.flush();
    f2.close();
  }
}

// =======================
// SD CARD: LOAD Wi-Fi CREDENTIALS
// =======================
bool loadWifiFromSD(String &outSsid, String &outPass) {
  if (!sdCardReady)
    return false;

  const char *targetFile = WIFI_CONFIG_FILE;
  if (!SD.exists(targetFile)) {
    if (SD.exists("/config") && SD.exists("/config/wifi.cfg")) {
      targetFile = "/config/wifi.cfg";
    } else {
      return false;
    }
  }

  File f = SD.open(targetFile, FILE_READ);
  if (!f)
    return false;
  outSsid = "";
  outPass = "";
  while (f.available()) {
    String line = f.readStringUntil('\n');
    line.trim();
    if (line.startsWith("SSID=")) {
      outSsid = line.substring(5);
      outSsid.trim();
    } else if (line.startsWith("PASSWORD=")) {
      outPass = line.substring(9);
      outPass.trim();
    }
  }
  f.close();
  if (outSsid.length() > 0) {
    Serial.println("[SD] Wi-Fi credentials loaded from SD card (" +
                   String(targetFile) + "). SSID: '" + outSsid + "'");
    return true;
  }
  return false;
}

// =======================
// NVS: SAVE Wi-Fi CREDENTIALS
// =======================
void saveWifiToNVS(String ssid, String pass) {
  preferences.begin("charrm_wifi", true);
  String existingSsid = preferences.getString("ssid", "");
  String existingPass = preferences.getString("pass", "");
  preferences.end();
  if (existingSsid == ssid && existingPass == pass) {
    return; // Already identical in NVS; skip flash erase/write during boot
  }

  preferences.begin("charrm_wifi", false);
  preferences.clear();
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
    String rxChunk = pCharacteristic->getValue().c_str();
    if (rxChunk.length() == 0)
      return;

    unsigned long now = millis();
    if (now - lastBleRxTime > 2000) {
      bleRxBuffer = ""; // Reset stale partial buffer
    }
    lastBleRxTime = now;
    bleRxBuffer += rxChunk;
    bleRxBuffer.trim();

    Serial.println("[BLE RX] Chunk (" + String(rxChunk.length()) +
                   "B) -> Buffer: " + bleRxBuffer);

    // If payload is JSON (starts with '{'), wait until closing '}' arrives
    // so multi-packet BLE writes never get split on ':'!
    if (bleRxBuffer.startsWith("{")) {
      if (bleRxBuffer.indexOf('}') == -1) {
        Serial.println("[BLE RX] Waiting for remaining JSON chunk...");
        return;
      }

      DynamicJsonDocument doc(512);
      DeserializationError err = deserializeJson(doc, bleRxBuffer);
      bleRxBuffer = "";
      if (err == DeserializationError::Ok) {
        String cmd = String(doc["cmd"] | "");
        String newSsid = String(doc["ssid"] | "");
        String newPass = String(doc["pass"] | "");
        cmd.trim();
        newSsid.trim();
        newPass.trim();

        if (cmd.equalsIgnoreCase("FORGET") || cmd.equalsIgnoreCase("RESET") ||
            newSsid.equalsIgnoreCase("FORGET") ||
            newSsid.equalsIgnoreCase("RESET")) {
          pendingForget = true;
          return;
        }

        if (newSsid.length() > 0 && !newWifiCredentialsReceived) {
          pendingBleSsid = newSsid;
          pendingBlePass = newPass;
          newWifiCredentialsReceived = true;
        }
      } else {
        Serial.println("[BLE RX] JSON parse error: " + String(err.c_str()));
      }
      return;
    }

    // Plain-text fallback commands ("FORGET", "WIFI:ssid,pass", "ssid,pass")
    String payload = bleRxBuffer;
    bleRxBuffer = "";
    if (payload.equalsIgnoreCase("FORGET") ||
        payload.equalsIgnoreCase("RESET") ||
        payload.equalsIgnoreCase("RESET_WIFI")) {
      pendingForget = true;
      return;
    }

    if (payload.startsWith("WIFI:") || payload.startsWith("wifi:")) {
      payload = payload.substring(5);
    }

    String newSsid = "";
    String newPass = "";
    int comma = payload.indexOf(',');
    int colon = payload.indexOf(':');
    if (comma != -1) {
      newSsid = payload.substring(0, comma);
      newPass = payload.substring(comma + 1);
    } else if (colon != -1) {
      newSsid = payload.substring(0, colon);
      newPass = payload.substring(colon + 1);
    } else {
      newSsid = payload;
    }
    newSsid.trim();
    newPass.trim();

    if (newSsid.length() > 0 && !newWifiCredentialsReceived) {
      pendingBleSsid = newSsid;
      pendingBlePass = newPass;
      newWifiCredentialsReceived = true;
    }
  }
};

void initBleStackOnce() {
  if (bleStackInitialized)
    return;

  Serial.println("[BLE] Initializing Bluetooth Stack (" +
                 String(BLE_DEVICE_NAME) + ")...");
  Serial.flush();

  delay(100); // Let 12V buck converter rail settle before RF calibration
  BLEDevice::init(BLE_DEVICE_NAME);
  BLEDevice::setMTU(517);
  delay(100);
  lcd.begin(16, 2); // Recover I2C LCD in case buck converter dipped during RF init

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

  // Primary Advertisement Data: Flags (3B) + Complete Device Name (22B) = 25B (<= 31B)
  // Putting the device name in the primary advertisement ensures Chrome/Edge Web Bluetooth
  // immediately sees "CHARRMPASS_ENTRY_BLE" on the first advertisement packet!
  BLEAdvertisementData oAdvertisementData = BLEAdvertisementData();
  oAdvertisementData.setFlags(0x06);
  oAdvertisementData.setName(BLE_DEVICE_NAME);
  pAdvertising->setAdvertisementData(oAdvertisementData);

  // Scan Response Data: Complete 128-bit Service UUID (18B <= 31B)
  BLEAdvertisementData oScanResponseData = BLEAdvertisementData();
  oScanResponseData.setCompleteServices(BLEUUID(BLE_SERVICE_UUID));
  pAdvertising->setScanResponseData(oScanResponseData);

  bleStackInitialized = true;
  Serial.println("[BLE] Bluetooth GATT Server & Service initialized.");
  Serial.flush();
}

void stopBleAndFreeRam() {
  if (!bleStackInitialized && !bleServerRunning) {
    return;
  }
  Serial.println("[BLE] Stopping Bluetooth stack to free internal RAM for Wi-Fi...");
  Serial.flush();
  if (bleClientConnected && pBleServer != nullptr) {
    pBleServer->disconnect(pBleServer->getConnId());
    delay(150);
  }
  if (bleServerRunning) {
    BLEDevice::getAdvertising()->stop();
    bleServerRunning = false;
  }
  delay(100);
  BLEDevice::deinit(true);
  btStop();
  pBleServer = nullptr;
  pBleCharacteristic = nullptr;
  bleStackInitialized = false;
  bleClientConnected = false;
  delay(200);
  Serial.printf("[BLE] Bluetooth stack released. Free Heap: %u bytes (Max Alloc: %u bytes)\n",
                ESP.getFreeHeap(), ESP.getMaxAllocHeap());
  Serial.flush();
}

void startBleServer() {
  Serial.println("[BLE] Initializing Bluetooth Provisioning Server (" +
                 String(BLE_DEVICE_NAME) + ")...");
  Serial.flush();
  lcdMsg("BLE SETUP MODE", "PAIR ON WEB/APP");

  // CRITICAL: Ensure Wi-Fi driver is completely OFF before starting Bluedroid BLE
  // so both stacks never compete for internal DRAM (~145KB available).
  if (WiFi.getMode() != WIFI_OFF) {
    Serial.println("[BLE] Turning off Wi-Fi driver to dedicate RAM & 2.4GHz radio to Bluetooth...");
    secureClient.stop();
    WiFi.setAutoReconnect(false);
    WiFi.disconnect(true, false);
    WiFi.mode(WIFI_OFF);
    delay(250);
  }
  wifiConnected = false;

  // If heap is tight (< 75KB contiguous) before starting Bluedroid BLE,
  // release the 18.6KB ramWhitelist buffer in-place (SD card fallback still works!)
  // instead of triggering a reboot loop at boot!
  if (!bleStackInitialized && ESP.getMaxAllocHeap() < 75000) {
    if (ramWhitelist != NULL) {
      Serial.println("[BLE] Releasing 18.6KB RAM cache to give Bluedroid contiguous heap (SD fallback active)...");
      free(ramWhitelist);
      ramWhitelist = NULL;
      ramWhitelistCount = 0;
    }
    if (ramInsideList != NULL) {
      free(ramInsideList);
      ramInsideList = NULL;
    }
  }

  // Only reboot if heap is STILL severely fragmented (< 55KB) after long uptime (> 15s)
  if (!bleStackInitialized && ESP.getMaxAllocHeap() < 55000 && millis() > 15000) {
    Serial.println("[BLE] Fragmented heap after long runtime -> Fast 1s reboot into clean BLE Setup Mode...");
    Serial.flush();
    preferences.begin("charrm_ble", false);
    preferences.putBool("force_ble", true);
    preferences.end();
    delay(150);
    ESP.restart();
  }

  if (!bleStackInitialized) {
    initBleStackOnce();
  }

  BLEDevice::getAdvertising()->start();
  BLEDevice::startAdvertising();
  bleServerRunning = true;
  lcdMsg("BLE SETUP MODE", "PAIR ON WEB/APP");
  Serial.println("[BLE] >>> BROADCASTING AS '" + String(BLE_DEVICE_NAME) +
                 "' (Ready for Pairing) <<<");
  Serial.flush();
}

void pauseBleAdvertising() {
  if (bleServerRunning) {
    BLEDevice::getAdvertising()->stop();
    bleServerRunning = false;
    Serial.println("[BLE] Wi-Fi connected! Paused BLE advertising.");
  }
}

// =======================
// FORGET WI-FI & OPEN BLUETOOTH PROVISIONING
// =======================
void forgetWifiAndStartBle() {
  Serial.println("\n===========================================");
  Serial.println("[WIFI RESET] FORGETTING CURRENT WI-FI & OPENING BLUETOOTH...");
  Serial.println("===========================================");

  inBleSetupMode = true; // Stay in BLE Setup Mode until user encodes new SSID & Pass

  lcdMsg("FORGETTING WIFI", "CLEARING SD&NVS");
  tone(BUZZER_PIN, 1500, 200);

  // 0. Close any open TLS socket before disconnecting Wi-Fi
  secureClient.stop();
  WiFi.setAutoReconnect(false);

  // 1. Wipe NVS credentials
  preferences.begin("charrm_wifi", false);
  preferences.clear();
  preferences.end();
  Serial.println("[NVS] Wi-Fi preferences erased.");

  // 2. Remove SD Wi-Fi config files (/wifi.cfg and /config/wifi.cfg)
  if (sdCardReady) {
    if (SD.exists(WIFI_CONFIG_FILE)) {
      SD.remove(WIFI_CONFIG_FILE);
      Serial.println("[SD] Removed " + String(WIFI_CONFIG_FILE));
    }
    if (SD.exists("/config") && SD.exists("/config/wifi.cfg")) {
      SD.remove("/config/wifi.cfg");
      Serial.println("[SD] Removed /config/wifi.cfg");
    }
  }

  // 3. Clear in-memory credentials & state
  currentSsid = "";
  currentPass = "";
  wifiConnected = false;

  // 4. Shut down Wi-Fi driver completely so Bluedroid BLE gets all internal RAM
  WiFi.disconnect(true, true);
  WiFi.mode(WIFI_OFF);
  delay(250);

  // 5. Start BLE Provisioning Server & Advertise immediately
  startBleServer();

  showReady(); // Displays "BLE SETUP MODE" / "PAIR ON WEB/APP"
  tone(BUZZER_PIN, 2000, 300);
  Serial.println("[BLE] >>> READY FOR BLUETOOTH PAIRING & SSID/PASS ENCODING <<<");
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

  // Update LCD immediately BEFORE radio startup so the screen never stays on "SD CACHE READY"
  lcdMsg("WIFI CONNECT 1/3", testSsid.substring(0, 16));

  // 1. CRITICAL: Release Bluetooth stack before starting Wi-Fi driver!
  bool cameFromBle = (bleStackInitialized || bleServerRunning);
  if (cameFromBle) {
    stopBleAndFreeRam();
  }

  // If heap is low after BLE deinit, free ramWhitelist in-place first (saves 18.6KB without rebooting!)
  if (ESP.getMaxAllocHeap() < 55000 && ramWhitelist != NULL) {
    Serial.println("[WIFI] Temporarily freeing 18.6KB RAM cache for Wi-Fi driver startup...");
    free(ramWhitelist);
    ramWhitelist = NULL;
    ramWhitelistCount = 0;
  }

  // Only reboot if we just came from BLE AND heap is STILL < 45KB even after freeing ramWhitelist
  if (cameFromBle && ESP.getMaxAllocHeap() < 45000) {
    Serial.println("[WIFI] Reclaiming Bluetooth RAM via fast 1s reboot -> Connecting from SD Card (/wifi.cfg)...");
    Serial.flush();
    saveWifiToSD(testSsid, testPass);
    saveWifiToNVS(testSsid, testPass);
    delay(150);
    ESP.restart();
  }

  // 2. Buck-Converter-Safe Wi-Fi Radio Initialization:
  // Pause 150ms after SD card activity so the 12V buck converter capacitor is fully charged,
  // then start Wi-Fi STA and immediately cap TX power to 11 dBm (~60% lower peak current spike!).
  delay(150);
  if (WiFi.getMode() != WIFI_STA) {
    WiFi.mode(WIFI_STA);
    WiFi.setTxPower(WIFI_POWER_11dBm); // Prevents 500mA RF spike on 12V battery buck converter!
    delay(200);
    lcd.begin(16, 2); // Re-sync I2C LCD in case 5V rail had a microsecond ripple during RF init
  } else {
    WiFi.setTxPower(WIFI_POWER_11dBm);
  }
  WiFi.persistent(false);
  WiFi.setAutoReconnect(false);
  applyWifiPowerSave();

  const int MAX_ATTEMPTS = 3;
  int perAttemptTimeout = 12; // 12 seconds per attempt

  for (int attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    Serial.printf("\n[WIFI] --> Attempt %d of %d to connect to '%s' (FreeHeap: %u, MaxBlock: %u)...\n",
                  attempt, MAX_ATTEMPTS, testSsid.c_str(), ESP.getFreeHeap(), ESP.getMaxAllocHeap());
    lcdMsg("WIFI CONNECT " + String(attempt) + "/3", testSsid.substring(0, 16));

    WiFi.disconnect(false, false);
    delay(200);

    if (testPass.length() > 0) {
      WiFi.begin(testSsid.c_str(), testPass.c_str());
    } else {
      WiFi.begin(testSsid.c_str(), NULL);
    }
    WiFi.setTxPower(WIFI_POWER_11dBm);

    // Check if Wi-Fi driver failed to allocate its FreeRTOS task (Status 254 / WL_NO_SHIELD)
    delay(150);
    if (((int)WiFi.status() == 254 || WiFi.status() == WL_NO_SHIELD) && cameFromBle) {
      Serial.println("\n[WIFI] Driver task allocation needed clean heap (Status 254) -> Fast 1s reboot to connect from SD Card (/wifi.cfg)...");
      Serial.flush();
      saveWifiToSD(testSsid, testPass);
      saveWifiToNVS(testSsid, testPass);
      delay(150);
      ESP.restart();
    }

    int elapsed = 0;
    while (WiFi.status() != WL_CONNECTED && elapsed < perAttemptTimeout * 2) {
      delay(500);
      Serial.print(".");
      elapsed++;

      if (WiFi.status() == WL_CONNECT_FAILED) {
        Serial.println("\n[WIFI ERROR] WL_CONNECT_FAILED (Code 4): Password was rejected!");
        break;
      }
      if (WiFi.status() == WL_NO_SSID_AVAIL && elapsed >= 8) {
        Serial.println("\n[WIFI ERROR] WL_NO_SSID_AVAIL (Code 1): SSID '" +
                       testSsid + "' not found on 2.4GHz band!");
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
      inBleSetupMode = false;
      WiFi.setTxPower(WIFI_POWER_15dBm); // Moderate stable TX power once associated
      applyWifiPowerSave();
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

      // Ensure SD Card & NVS are synced with verified credentials
      saveWifiToSD(testSsid, testPass);
      saveWifiToNVS(testSsid, testPass);
      currentSsid = testSsid;
      currentPass = testPass;

      if (ramWhitelist == NULL) {
        loadWhitelistFromSDToRAM();
      }

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

  // ── ALL 3 ATTEMPTS EXHAUSTED: Shut down Wi-Fi and Open Bluetooth for Provisioning ──
  wifiConnected = false;
  inBleSetupMode = true;
  int st = WiFi.status();
  String errDetail = "3 Attempts Timed Out";
  if (st == WL_NO_SSID_AVAIL) {
    errDetail = "SSID not found on 2.4GHz";
  } else if (st == WL_CONNECT_FAILED) {
    errDetail = "Password rejected";
  }

  Serial.println("\n[WIFI] ❌ 3 connection attempts failed (" + errDetail +
                 "). Turning off Wi-Fi & opening Bluetooth for provisioning.");
  WiFi.setAutoReconnect(false);
  WiFi.disconnect(true, false);
  WiFi.mode(WIFI_OFF);
  delay(250);

  lcdMsg("WIFI FAILED 3/3", "BLUETOOTH OPEN");
  delay(1500);

  startBleServer();

  // Send failure event over BLE if client is connected
  String failPayload = "{\"event\":\"FAILED\",\"error\":\"" + errDetail +
                       "\",\"code\":" + String(st) + "}";
  sendBleStatus(failPayload);

  return false;
}

// =======================
// SETUP
// =======================
void setup() {
  WRITE_PERI_REG(
      RTC_CNTL_BROWN_OUT_REG,
      0); // Prevent false brownout reboots during simultaneous WiFi TX + buzzer

  // NOTE: Do NOT call esp_bt_controller_mem_release(ESP_BT_MODE_CLASSIC_BT) here!
  // Arduino-ESP32's btStart() initializes the BT controller using BTDM config;
  // releasing CLASSIC_BT beforehand causes BLEDevice::init() to hang forever.

  secureClient.setInsecure(); // Supabase HTTPS without root cert bundle (saves 35KB RAM)
  secureClient.setHandshakeTimeout(8); // Cap TLS handshake to 8s
  Serial.begin(115200);
  delay(500); // Allow 12V buck converter rail, UART, and peripherals to stabilize
  Serial.println("\n===========================================");
  Serial.println("  CHARRMPASS — ENTRY GATE (13.56 MHz HF)");
  Serial.println("===========================================\n");
  Serial.flush();

  Serial.println("[BOOT] Initializing I2C bus and LCD...");
  Wire.begin(21, 22);
  Wire.setTimeOut(50); // 50ms I2C timeout prevents buck-converter power glitches from locking LCD
  lcd.begin(16, 2);
  lcdMsg("  CHARRMPASS  ", "ENTRY GATE HF");
  delay(800);

  pinMode(RED_LED, OUTPUT);
  pinMode(YELLOW_LED, OUTPUT);
  pinMode(GREEN_LED, OUTPUT);
  pinMode(BUZZER_PIN, OUTPUT);
  pinMode(BOOT_BUTTON_PIN, INPUT_PULLUP);
  setTrafficLight(true, false, false); // Initial Standby: RED ON

  // 1. Initialize RFID on VSPI (Default SPI: SCK 18, MISO 19, MOSI 23, SS 5)
  SPI.begin();
  rfid.PCD_Init();
  rfid.PCD_SetAntennaGain(MFRC522::RxGain_max);
  Serial.println("[RFID] 13.56 MHz HF Initialized on VSPI (SS 5, SCK 18, MISO 19, MOSI 23)");

  // 2. Initialize SD Card on dedicated HSPI Bus FIRST (before Wi-Fi/BLE radio tasks start)
  initSDCard();

  // Load last-known wall-clock epoch time for accurate offline scan timestamps
  preferences.begin("charrm_time", true);
  savedEpoch = (time_t)preferences.getULong("epoch", 0);
  preferences.end();

  // Check if we rebooted specifically to enter clean BLE Setup Mode
  preferences.begin("charrm_ble", false);
  bool forceBle = preferences.getBool("force_ble", false);
  if (forceBle) {
    preferences.putBool("force_ble", false);
  }
  preferences.end();

  if (forceBle) {
    Serial.println("[BOOT] Clean BLE Setup Mode requested -> Starting Bluetooth Provisioning Server...");
    inBleSetupMode = true;
    startBleServer();
    showReady();
    return;
  }

  // 2b. Allocate RAM cache dynamically on Heap and load SD whitelist
  ramWhitelist = (WhitelistCard *)calloc(MAX_RAM_CARDS, sizeof(WhitelistCard));
  if (ramWhitelist == NULL) {
    Serial.println("[ERROR] Failed to allocate RAM cache memory!");
  } else {
    Serial.println("[BOOT] Dynamic RAM cache allocated successfully (" +
                   String(MAX_RAM_CARDS) + " cards).");
  }
  loadWhitelistFromSDToRAM();

  // 3. Load Saved Wi-Fi Credentials (DO NOT initialize BLE before Wi-Fi!)
  // Priority 1: SD Card (/wifi.cfg or /config/wifi.cfg)
  lcdMsg("LOADING CONFIG..", "CHECKING WIFI...");
  if (loadWifiFromSD(currentSsid, currentPass)) {
    Serial.println("[BOOT] Loaded Wi-Fi credentials from SD Card: '" +
                   currentSsid + "'");
    saveWifiToNVS(currentSsid, currentPass); // Keep NVS in sync with SD card
  }

  // Priority 2: NVS Flash (if SD card had no Wi-Fi config)
  if (currentSsid.length() == 0) {
    preferences.begin("charrm_wifi", true);
    currentSsid = preferences.getString("ssid", "");
    currentPass = preferences.getString("pass", "");
    preferences.end();
    if (currentSsid.length() > 0) {
      Serial.println("[BOOT] Loaded Wi-Fi credentials from NVS: '" +
                     currentSsid + "'");
      saveWifiToSD(currentSsid, currentPass); // Mirror to SD card
    }
  }

  // Priority 3: Firmware default constants (only if SD & NVS are both empty)
  if (currentSsid.length() == 0 &&
      String(DEFAULT_WIFI_SSID) != "YOUR_WIFI_SSID" &&
      strlen(DEFAULT_WIFI_SSID) > 0) {
    currentSsid = DEFAULT_WIFI_SSID;
    currentPass = DEFAULT_WIFI_PASS;
    Serial.println("[BOOT] Loaded default Wi-Fi credentials from firmware code.");
  }

  if (currentSsid.length() > 0) {
    Serial.println("[BOOT] Wi-Fi credentials found: '" + currentSsid +
                   "'. Attempting connection (3 tries max)...");
    bool wifiOk = attemptWifiConnection(currentSsid, currentPass, 20);
    if (!wifiOk) {
      Serial.println("[BOOT] Wi-Fi failed after 3 attempts. Operating in "
                     "Offline SD Cache Mode with BLE Open.");
    }
  } else {
    Serial.println(
        "[BOOT] No saved Wi-Fi credentials found in SD, NVS, or code.");
    Serial.println(
        "[BOOT] Entering BLE Setup Mode for wireless provisioning...");
    inBleSetupMode = true;
    startBleServer();
  }

  // Make turnstile ready immediately using local RAM/SD cache!
  showReady();

  // If connected, sync database in the background
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
  // ── 0. REMOTE / BLE "FORGET WI-FI" COMMAND HANDLER ──
  // Forgets current Wi-Fi (wipes SD & NVS) and goes straight to Bluetooth Setup Mode
  if (pendingForget) {
    pendingForget = false;
    forgetWifiAndStartBle();
  }

  // ── 1. ONBOARD BOOT BUTTON (GPIO 0): Hold for 3s to Forget Wi-Fi & Enter BLE Setup Mode ──
  static unsigned long bootButtonPressStart = 0;
  if (digitalRead(BOOT_BUTTON_PIN) == LOW) {
    if (bootButtonPressStart == 0) {
      bootButtonPressStart = millis();
    } else if (millis() - bootButtonPressStart >= 3000) {
      Serial.println("\n🔘 [HARDWARE BUTTON] BOOT button held for 3s -> Forgetting Wi-Fi & Opening BLE Setup Mode!");
      forgetWifiAndStartBle();
      bootButtonPressStart = 0;
      while (digitalRead(BOOT_BUTTON_PIN) == LOW) {
        delay(10);
      } // Wait for button release
    }
  } else {
    bootButtonPressStart = 0;
  }

  // ── 2. BLE CONNECTION EVENTS ──
  if (bleEvtConnected) {
    bleEvtConnected = false;
    Serial.println("\n[BLE] Web Client Connected via Bluetooth!");
    inBleSetupMode = true;
    lcdMsg("BLUETOOTH PAIRED", "ENCODE SSID&PASS");
    tone(BUZZER_PIN, 2000, 100);
  }
  if (bleEvtDisconnected) {
    bleEvtDisconnected = false;
    Serial.println("[BLE] Web Client Disconnected.");
    if (bleServerRunning && !wifiConnected && !newWifiCredentialsReceived) {
      BLEDevice::getAdvertising()->start();
      BLEDevice::startAdvertising();
      Serial.println("[BLE] Advertising resumed (device still in BLE Setup Mode).");
    }
    showReady();
  }

  // ── 3. BLE PROVISIONING FLOW: Bluetooth -> ESP32 -> Save to SD Card -> Connect to Wi-Fi ──
  if (newWifiCredentialsReceived) {
    String newSsid = pendingBleSsid;
    String newPass = pendingBlePass;
    newWifiCredentialsReceived = false;

    Serial.println("\n===========================================");
    Serial.println("[BLE PROVISION] Step 1: Received from Bluetooth -> SSID: '" +
                   newSsid + "' (" + String(newPass.length()) + " chars)");
    lcdMsg("WIFI RECEIVED", newSsid.substring(0, 16));
    tone(BUZZER_PIN, 2000, 150);
    delay(400);

    // Step 2: Save new SSID & Password to SD Card (and NVS) FIRST
    Serial.println("[BLE PROVISION] Step 2: Saving credentials to SD Card & NVS first...");
    lcdMsg("SAVING TO SD...", newSsid.substring(0, 16));
    saveWifiToSD(newSsid, newPass);
    saveWifiToNVS(newSsid, newPass);

    // Verify/load from SD card so connection uses SD-saved credentials
    String sdSsid = "", sdPass = "";
    if (loadWifiFromSD(sdSsid, sdPass) && sdSsid == newSsid) {
      currentSsid = sdSsid;
      currentPass = sdPass;
      Serial.println("[BLE PROVISION] Verified credentials on SD Card (/wifi.cfg).");
    } else {
      currentSsid = newSsid;
      currentPass = newPass;
    }

    sendBleStatus("{\"event\":\"SAVED\",\"ssid\":\"" + currentSsid + "\"}");
    lcdMsg("SD CARD SAVED!", "CONNECTING WIFI");
    tone(BUZZER_PIN, 2400, 150);
    delay(700); // Allow user to see "SD CARD SAVED!" and let BLE notification reach browser

    // Step 3: Release Bluetooth RAM and connect to Wi-Fi using the SD-saved credentials
    Serial.println("[BLE PROVISION] Step 3: Releasing BLE & connecting to Wi-Fi '" + currentSsid + "'...");
    stopBleAndFreeRam();

    bool ok = attemptWifiConnection(currentSsid, currentPass, 25);
    if (ok) {
      inBleSetupMode = false;
      Serial.println("[BLE PROVISION] ✅ Wi-Fi connected! Syncing with Supabase cloud...");
      sendDeviceHeartbeat();
      syncOfflineTransactionsToCloud();
      syncWhitelistToSD();
    } else {
      Serial.println("[BLE PROVISION] ❌ Wi-Fi connection failed. Returning to BLE Setup Mode for re-encoding.");
      inBleSetupMode = true;
      startBleServer();
    }
    showReady();
  }

  // Non-blocking ready reset timer
  if (isDisplayHolding && millis() >= readyResetTime) {
    isDisplayHolding = false;
    showReady();
  }

  // ── OFFLINE STATUS INDICATOR: Non-blocking blinking yellow LED ──
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
      Serial.println("[WARN] WiFi lost — SD Fallback Mode Active (Blinking YELLOW Standby)");
      showReady();
    } else if (inBleSetupMode && !bleServerRunning) {
      startBleServer();
    }
  } else {
    if (!wifiConnected) {
      wifiConnected = true;
      inBleSetupMode = false;
      applyWifiPowerSave();
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

  // ── BACKGROUND WI-FI RETRY (Every 30s when offline and NOT in BLE Setup Mode) ──
  static unsigned long lastWifiRetry = 0;
  if (WiFi.status() != WL_CONNECTED && currentSsid.length() > 0 &&
      !inBleSetupMode && !bleClientConnected && !newWifiCredentialsReceived &&
      millis() - lastWifiRetry > 30000) {
    lastWifiRetry = millis();
    Serial.println("[WIFI RETRY] Background reconnect to '" + currentSsid + "'");
    if (WiFi.getMode() != WIFI_STA)
      WiFi.mode(WIFI_STA);
    WiFi.setAutoReconnect(true);
    if (currentPass.length() > 0)
      WiFi.begin(currentSsid.c_str(), currentPass.c_str());
    else
      WiFi.begin(currentSsid.c_str(), NULL);
  }

  // While offline, flush any queued RAM scans immediately to SD card
  if (txQueueCount > 0 && (!wifiConnected || WiFi.status() != WL_CONNECTED)) {
    flushQueueToSD();
  }

  // Asynchronous Background Cloud Transaction Dispatch (Zero Turnstile Delay)
  processCloudQueue();
  if (wifiConnected && WiFi.status() == WL_CONNECTED) {
    persistEpochIfValidEntry();
  }

  // Fast Remote Wi-Fi Reset Command Poll (Every 5 seconds when online)
  static unsigned long lastRemoteCmdCheck = 0;
  if (wifiConnected && WiFi.status() == WL_CONNECTED && !isDisplayHolding &&
      txQueueCount == 0 && (millis() - lastRemoteCmdCheck > 5000)) {
    lastRemoteCmdCheck = millis();
    checkRemoteWifiCommand();
  }

  // Periodic Full Heartbeat to Supabase (Every 60 seconds)
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

      // ── BLE / START_BLE → Force BLE Setup Mode ──
      if (inputStr.equalsIgnoreCase("BLE") ||
          inputStr.equalsIgnoreCase("START_BLE") ||
          inputStr.equalsIgnoreCase("BLE_ON")) {
        inBleSetupMode = true;
        startBleServer();
        showReady();
        Serial.println("[BLE] >>> FORCED BLE SETUP MODE & ADVERTISING ACTIVE <<<");
        return;
      }

      // ── RESET / FORGET → Forget current Wi-Fi (NVS & SD) and go straight to BLE ──
      if (inputStr.equalsIgnoreCase("RESET:") ||
          inputStr.equalsIgnoreCase("RESET") ||
          inputStr.equalsIgnoreCase("FORGET") ||
          inputStr.equalsIgnoreCase("RESET_WIFI")) {
        forgetWifiAndStartBle();
        return;
      }

      // ── WIFI:<SSID>,<PASS> → Save credentials to SD & NVS then connect ──
      if (inputStr.startsWith("WIFI:") || inputStr.startsWith("wifi:")) {
        String payload = inputStr.substring(5);
        int comma = payload.indexOf(',');
        if (comma != -1) {
          pendingBleSsid = payload.substring(0, comma);
          pendingBlePass = payload.substring(comma + 1);
        } else {
          pendingBleSsid = payload;
          pendingBlePass = "";
        }
        pendingBleSsid.trim();
        pendingBlePass.trim();
        if (pendingBleSsid.length() > 0) {
          newWifiCredentialsReceived = true;
        }
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
