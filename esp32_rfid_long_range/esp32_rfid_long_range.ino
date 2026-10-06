/*
 * =====================================================================================
 * CHARRMPASS — ESP32 LONG-RANGE UHF AUTOMATED VEHICLE ENTRY MONITOR (NO BARRIER)
 * =====================================================================================
 *
 * DEDICATED VEHICLE ENTRY GATE MONITOR:
 *   - Operating Frequency: ~860–960 MHz UHF (Boland / Wiegand 26/34 Long-Range RFID)
 *   - Role: Dedicated Automated Vehicle Entry Monitor (Free-flow automated logging, NO barrier arm)
 *   - High-throughput Inbound Detection:
 *       * All detected vehicles are logged as "ENTRY"
 *       * 15-second Transit Anti-Passback Debounce suppresses duplicate repeat scans as car passes
 *   - Standalone Vehicle Device: Free-flow automated drive-through monitoring for ASU-Ibajay campus.
 *
 * ARDUINO IDE UPLOAD SETTINGS (IMPORTANT):
 *   - Board: "ESP32 Dev Module" (or any standard ESP32 board)
 *   - Partition Scheme: "Huge APP (3MB No OTA/1MB SPIFFS)" <-- MUST SET THIS!
 *     (Required because Wi-Fi + BLE + mbedTLS together use ~1.9MB of flash)
 *   - Upload Speed: 921600 or 115200
 *
 * WI-FI CONNECTION & PROVISIONING:
 *   - Set default Wi-Fi network below (DEFAULT_WIFI_SSID / DEFAULT_WIFI_PASS)
 *   - Or configure wirelessly via Web Bluetooth (BLE) from the Admin Dashboard
 *   - Or change Over-The-Air anytime with 1-click from the Web Admin Dashboard
 *   - Or configure via MicroSD card (/config/wifi.cfg) or Serial Monitor ('WIFI:ssid,pass')
 *   - Reset Wi-Fi: Hold onboard BOOT button for 3s, or type 'RESET' in Serial Monitor
 * =====================================================================================
 */

#define GATE_ID "CHARRMPASS_GATE_01"
#define GATE_NAME "CHARRMPASS Gate Unit 1"
#define GATE_TYPE "ENTRY"
#define GATE_CATEGORY "VEHICLE (ENTRY)"
#define GATE_LOCATION "Main Gate"
#define RFID_RANGE_MODE "LONG_RANGE"
#define RFID_FREQUENCY "~860–960 MHz UHF"

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
#include <esp_wifi.h> // for esp_wifi_set_ps()
#include <esp_bt.h>   // for esp_bt_controller_mem_release()
#include <hd44780.h>
#include <hd44780ioClass/hd44780_I2Cexp.h>

// BLE Libraries for wireless Web Bluetooth provisioning
#include <BLEDevice.h>
#include <BLEServer.h>
#include <BLEUtils.h>
#include <BLE2902.h>

// BLE Service & Characteristic UUIDs (Matches CHARRMPASS Web App)
#define BLE_SERVICE_UUID "4fafc201-1fb5-459e-8fcc-c5c9c331914b"
#define BLE_CHAR_UUID    "beb5483e-36e1-4688-b7f5-ea07361b26a8"
#define BLE_DEVICE_NAME  "CHARRMPASS_UHF_BLE"

// =======================
// WI-FI CREDENTIALS & SETTINGS
// Wi-Fi can be configured wirelessly via Web Bluetooth from the Admin Dashboard,
// Over-The-Air remotely, or via MicroSD card (/config/wifi.cfg).
// =======================
const char *DEFAULT_WIFI_SSID = "YOUR_WIFI_SSID";
const char *DEFAULT_WIFI_PASS = "YOUR_WIFI_PASSWORD";

// Hardware Pin Configuration — Boland UHF Reader (Wiegand)
#define ENABLE_WIEGAND true
#define WIEGAND_D0_PIN                                                         \
  32 // GREEN wire: Wiegand Data 0 (D0) with internal pull-up
#define WIEGAND_D1_PIN                                                         \
  33 // WHITE wire: Wiegand Data 1 (D1) with internal pull-up

// Interrupt-safe Wiegand pulse buffer with independent microsecond noise
// filtering
volatile uint64_t wiegandRawBits = 0;
volatile int wiegandBitCount = 0;
volatile uint32_t lastPulseD0Us = 0;
volatile uint32_t lastPulseD1Us = 0;
volatile uint32_t lastWiegandActivityUs = 0;
volatile uint32_t countD0 = 0;
volatile uint32_t countD1 = 0;
volatile uint32_t wiegandTotalPulses = 0;

void IRAM_ATTR isrWiegandD0() {
  uint32_t now = micros();
  // Filter electrical ringing under 30us
  if (now - lastPulseD0Us < 30)
    return;
  lastPulseD0Us = now;
  lastWiegandActivityUs = now;
  countD0++;
  wiegandTotalPulses++;
  if (wiegandBitCount < 64) {
    wiegandRawBits <<= 1;
    wiegandBitCount++;
  } else {
    wiegandBitCount = 0;
    wiegandRawBits = 0;
  }
}

void IRAM_ATTR isrWiegandD1() {
  uint32_t now = micros();
  // Filter electrical ringing under 30us
  if (now - lastPulseD1Us < 30)
    return;
  lastPulseD1Us = now;
  lastWiegandActivityUs = now;
  countD1++;
  wiegandTotalPulses++;
  if (wiegandBitCount < 64) {
    wiegandRawBits = (wiegandRawBits << 1) | 1ULL;
    wiegandBitCount++;
  } else {
    wiegandBitCount = 0;
    wiegandRawBits = 0;
  }
}

#define ENABLE_SPI_MFRC522 true
#define RFID_SS_PIN 5
#define RFID_RST_PIN 27

#define SD_CS_PIN 13
#define SD_MOSI_PIN 12
#define SD_MISO_PIN 14
#define SD_SCK_PIN 26

#define RELAY_PIN 25 // Auxiliary pass indicator / beacon relay (Free-flow pass, no barrier arm)
#define GREEN_LED 4
#define RED_LED 2
#define BUZZER_PIN 15
#define BOOT_BUTTON_PIN 0 // ESP32 onboard BOOT button

// =====================================================
// 2. SUPABASE CLOUD REST API
// =====================================================
const char *SUPABASE_URL = "https://xrdpgsnastqnbhvdltwt.supabase.co";
const char *SUPABASE_ANON =
    "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9."
    "eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InhyZHBnc25hc3RxbmJodmRsdHd0Iiwicm9sZSI6Im"
    "Fub24iLCJpYXQiOjE3OTEzMDQxMjgsImV4cCI6MjEwNjg4MDEyOH0.1ZKaUnEmB9B7"
    "PVk8arIhkGRqoxJbv6-VzflUaB7mZiE";

// =====================================================
// 3. GLOBAL OBJECTS & STATE
// =====================================================
hd44780_I2Cexp lcd;
MFRC522 rfid(RFID_SS_PIN, RFID_RST_PIN);
SPIClass spiSD(HSPI);
Preferences preferences;
WiFiClientSecure secureClient;

// BLE Server handles & wireless provisioning state
BLEServer* pBleServer = NULL;
BLECharacteristic* pBleCharacteristic = NULL;
bool bleClientConnected = false;
bool bleServerRunning = false;
volatile bool newWifiCredentialsReceived = false;
String pendingBleSsid = "";
String pendingBlePass = "";

// BLE callbacks run on the Bluetooth stack task. They must NOT touch the I2C
// LCD, buzzer delays, or Wi-Fi. They only raise these flags; loop() does the work.
volatile bool bleEvtConnected = false;
volatile bool bleEvtDisconnected = false;

String currentSsid = "";
String currentPass = "";

// Background Wi-Fi reconnect watchdog (non-blocking)
unsigned long lastWifiRetryMs = 0;
const unsigned long WIFI_RETRY_INTERVAL = 30000; // retry saved network every 30s

// ESP32 shares ONE 2.4GHz radio between Wi-Fi and BLE. When the BT controller
// is running, ESP-IDF requires Wi-Fi modem sleep - WIFI_PS_NONE triggers
// "Should enable WiFi modem sleep when both WiFi and Bluetooth are enabled"
// and aborts (reboots) the chip. Only disable sleep when BLE is off.
void applyWifiPowerSave() {
  if (bleServerRunning) {
    esp_wifi_set_ps(WIFI_PS_MIN_MODEM);
  } else {
    esp_wifi_set_ps(WIFI_PS_NONE);
  }
}

bool wifiConnected = false;
bool sdCardReady = false;
unsigned long lastHeartbeat = 0;
const unsigned long HEARTBEAT_INTERVAL =
    60000; // 60 seconds periodic health check

const char *WHITELIST_FILE = "/uhf_whitelist.csv";
const char *INSIDE_LIST_FILE = "/currently_inside.csv";
const char *OFFLINE_TX_FILE = "/offline_txns.csv";
const char *WIFI_CONFIG_FILE = "/config/wifi.cfg"; // SD Wi-Fi backup
const char *OFFLINE_TX_TMP = "/offline_txns.tmp";

// -----------------------------------------------------
// OFFLINE BUFFER SETTINGS
// -----------------------------------------------------
#define OFFLINE_FLUSH_BATCH 5 // records uploaded per pass after reconnect

// Returns UTC ISO-8601 time, or "" if NTP has not synced yet.
String isoUtcNow() {
  time_t now = time(nullptr);
  if (now < 1700000000)
    return "";
  struct tm t;
  gmtime_r(&now, &t);
  char buf[25];
  strftime(buf, sizeof(buf), "%Y-%m-%dT%H:%M:%SZ", &t);
  return String(buf);
}

// =====================================================
// 1. CONFIGURABLE MULTI-READ VALIDATION & PRESENCE PARAMETERS
//    (Prioritizes Correctness over Speed)
// =====================================================
const int REQUIRED_MATCHES =
    1; // 1 = Instant responsive detection for vehicle drive-through (Hardware Wiegand parity already verified)
const int MAX_READ_ATTEMPTS =
    3; // Max read attempts
const unsigned long VALIDATION_WINDOW_MS =
    3500; // Time window if multi-read is enabled (3.5s)
const unsigned long PRESENCE_TIMEOUT_MS =
    3000; // Tag must disappear for 3s before vehicle cleared
const unsigned long MIN_COOLDOWN_MS =
    5000; // 5-second anti-spam debounce per vehicle event
const unsigned long DISPLAY_HOLD_MS =
    2500;                         // Time to keep status displayed on LCD (2.5s)
const char *READER_ID = "UHF-01"; // Physical reader identifier

// Reader State Machine
enum ReaderState {
  STATE_IDLE,
  STATE_DETECTING,
  STATE_VALIDATING,
  STATE_CONFIRMED,
  STATE_CHECKING_STATE,
  STATE_LOGGING,
  STATE_WAITING_FOR_CLEAR
};

ReaderState currentReaderState = STATE_IDLE;

// Multi-Read Validation Session
struct ValidationSession {
  String candidateUid;
  String candidateAltUid;
  int matchCount;
  int totalAttempts;
  unsigned long firstSeenMs;
  unsigned long lastReadMs;
};
ValidationSession valSession = {"", "", 0, 0, 0, 0};

// Presence Tracking & Cooldown Records (Tracks whether car is still in zone)
struct PresenceRecord {
  String uid;
  String plate;
  unsigned long lastSeenMs;
  unsigned long loggedAtMs;
  bool isPresentInZone;
};
#define MAX_PRESENCE_RECORDS 8
PresenceRecord presenceRecords[MAX_PRESENCE_RECORDS];

unsigned long transactionCounter = 1;

bool isUidInPresence(const String &uid, String &outPlate) {
  unsigned long now = millis();
  for (int i = 0; i < MAX_PRESENCE_RECORDS; i++) {
    if (presenceRecords[i].uid.length() > 0 &&
        presenceRecords[i].uid.equalsIgnoreCase(uid)) {
      bool cooldownExpired =
          (now - presenceRecords[i].loggedAtMs >= MIN_COOLDOWN_MS);
      if (!cooldownExpired) {
        outPlate = presenceRecords[i].plate;
        return true;
      }
    }
  }
  return false;
}

void registerPresence(const String &uid, const String &plate) {
  unsigned long now = millis();
  int freeIdx = -1;
  for (int i = 0; i < MAX_PRESENCE_RECORDS; i++) {
    if (presenceRecords[i].uid.equalsIgnoreCase(uid)) {
      presenceRecords[i].lastSeenMs = now;
      presenceRecords[i].loggedAtMs = now;
      presenceRecords[i].plate = plate;
      presenceRecords[i].isPresentInZone = true;
      return;
    }
    if (freeIdx == -1 && presenceRecords[i].uid.length() == 0) {
      freeIdx = i;
    }
  }
  if (freeIdx == -1)
    freeIdx = 0;
  presenceRecords[freeIdx].uid = uid;
  presenceRecords[freeIdx].plate = plate;
  presenceRecords[freeIdx].lastSeenMs = now;
  presenceRecords[freeIdx].loggedAtMs = now;
  presenceRecords[freeIdx].isPresentInZone = true;
}

void touchPresence(const String &uid) {
  unsigned long now = millis();
  for (int i = 0; i < MAX_PRESENCE_RECORDS; i++) {
    if (presenceRecords[i].uid.equalsIgnoreCase(uid)) {
      presenceRecords[i].lastSeenMs = now;
      return;
    }
  }
}

void cleanupPresenceRecords();
void showLcdIdle();
void showLcdDetecting();
void showLcdValidating(int current, int required, const String &uidSnippet);
void showLcdConfirmed(int matches, int required);
void showLcdEntry(const String &plate);
void showLcdExit(const String &plate);
void showLcdUnknown();
void showLcdDuplicate();
void showLcdMismatch();
void setLcdHolding(unsigned long durationMs = DISPLAY_HOLD_MS);
void handleUhfDetection(String uid, String altUid = "");
void processConfirmedTag(String finalUid, String altUid, int matchCount);
void updateReaderStateMachine();
bool isTagInCooldown(const String &uid);
void markTagInCooldown(const String &uid, const String &plate = "");
bool uhfReadConfirmed(const String &uid);
void initSDCard();

// =====================================================
// HIGH-SPEED IN-MEMORY RAM WHITELIST CACHE
// Enables < 0.1ms tag matching with ZERO network delay
// =====================================================
typedef struct {
  String uid;
  String name;
  String plate;
  String role;
  String userType;
  String vehicleId;
  String userId;
  bool authorized;
  bool isInside; // TRUE if vehicle is currently inside campus, FALSE if outside
  unsigned long lastActionTime; // Millis timestamp of last ENTRY/EXIT to
                                // prevent repeat flip-flop
  String cpassId;
} RamCard;

#define MAX_RAM_CARDS 128
RamCard ramCards[MAX_RAM_CARDS];
int ramCardCount = 0;
unsigned long lastWhitelistSync = 0;
const unsigned long WHITELIST_SYNC_INTERVAL =
    300000; // Auto-sync RAM every 5 minutes

int findCardInRam(const String &uid) {
  for (int i = 0; i < ramCardCount; i++) {
    if (ramCards[i].uid.equalsIgnoreCase(uid)) {
      return i;
    }
  }
  return -1;
}

void addCardToRam(String uid, String name, String plate, String role,
                  String userType, String vId, String uId, bool auth,
                  bool inside = false, String cpass = "") {
  int idx = findCardInRam(uid);
  if (idx != -1) {
    ramCards[idx].name = name;
    ramCards[idx].plate = plate;
    ramCards[idx].role = role;
    ramCards[idx].userType = userType;
    ramCards[idx].vehicleId = vId;
    ramCards[idx].userId = uId;
    ramCards[idx].authorized = auth;
    ramCards[idx].isInside = inside;
    if (cpass.length() > 0)
      ramCards[idx].cpassId = cpass;
    return;
  }
  if (ramCardCount < MAX_RAM_CARDS) {
    ramCards[ramCardCount].uid = uid;
    ramCards[ramCardCount].name = name;
    ramCards[ramCardCount].plate = plate;
    ramCards[ramCardCount].role = role;
    ramCards[ramCardCount].userType = userType;
    ramCards[ramCardCount].vehicleId = vId;
    ramCards[ramCardCount].userId = uId;
    ramCards[ramCardCount].authorized = auth;
    ramCards[ramCardCount].isInside = inside;
    ramCards[ramCardCount].lastActionTime = 0;
    ramCards[ramCardCount].cpassId = cpass;
    ramCardCount++;
  }
}

// =====================================================
// ASYNCHRONOUS BACKGROUND TRANSACTION QUEUE
// Prevents cloud HTTP calls from blocking Wiegand scanning
// =====================================================
struct QueuedTransaction {
  String uid;
  String direction;
  String status;
  String remarks;
  String vehicleId;
  String userId;
  String userType;
};
#define MAX_TX_QUEUE 32
QueuedTransaction txQueue[MAX_TX_QUEUE];
int txQueueHead = 0;
int txQueueTail = 0;
int txQueueCount = 0;

void enqueueTransaction(String uid, String dir, String status, String remarks,
                        String vId, String uId, String uType) {
  if (txQueueCount >= MAX_TX_QUEUE) {
    // Drop oldest to avoid buffer lock
    txQueueHead = (txQueueHead + 1) % MAX_TX_QUEUE;
    txQueueCount--;
  }
  txQueue[txQueueTail].uid = uid;
  txQueue[txQueueTail].direction = dir;
  txQueue[txQueueTail].status = status;
  txQueue[txQueueTail].remarks = remarks;
  txQueue[txQueueTail].vehicleId = vId;
  txQueue[txQueueTail].userId = uId;
  txQueue[txQueueTail].userType = uType;
  txQueueTail = (txQueueTail + 1) % MAX_TX_QUEUE;
  txQueueCount++;
}

// Scan verification state
bool card_found = false;
bool card_authorized = false;
String card_name = "";
String card_plate = "";
String card_role = "";
String card_cpassId = "";
String card_userType = "VEHICLE";
String card_rfidType = "LONG_RANGE";
String card_vehicleId = "";
String card_userId = "";
String calculatedDirection = "ENTRY";
unsigned long lastTagDisplayMillis = 0;

// Forward declarations
void sendDeviceHeartbeat();
void syncWhitelistToRam();
void triggerBarrier();
bool isTagCurrentlyInsideOnline(String uid);
void insertTransactionOnline(String uid, String direction, String status,
                             String remarks, String vId = "", String uId = "",
                             String uType = "VEHICLE");
bool attemptWifiConnection(String testSsid, String testPass,
                           int timeoutSeconds = 20);
void startBleServer();
void pauseBleAdvertising();
void sendBleStatus(String status);

// =====================================================
// 4. LCD & AUDIO HELPERS
// =====================================================
// Fast, flicker-free LCD write without full clear delay
void lcdShowFast(String line1, String line2) {
  char b1[17], b2[17];
  snprintf(b1, sizeof(b1), "%-16.16s", line1.c_str());
  snprintf(b2, sizeof(b2), "%-16.16s", line2.c_str());
  lcd.setCursor(0, 0);
  lcd.print(b1);
  lcd.setCursor(0, 1);
  lcd.print(b2);
  lastTagDisplayMillis = millis();
}

void lcdMsg(String line1, String line2) { lcdShowFast(line1, line2); }

void showReady() {
  digitalWrite(RED_LED, HIGH);
  digitalWrite(GREEN_LED, LOW);
  digitalWrite(RELAY_PIN, HIGH); // Relay off

  if (wifiConnected) {
    lcdShowFast("UHF VEHICLE ENT", "AUTO DRIVE-THRU");
  } else if (bleServerRunning) {
    lcdShowFast("[OFFLINE] BLE ON", "PAIR TO SET WIFI");
  } else {
    lcdShowFast("[OFFLINE] ENTRY", "AUTO DRIVE-THRU");
  }
}

void beep(int ms, int count = 1) {
  for (int i = 0; i < count; i++) {
    digitalWrite(BUZZER_PIN, HIGH);
    delay(ms);
    digitalWrite(BUZZER_PIN, LOW);
    if (count > 1)
      delay(40);
  }
}

void triggerBarrier() {
  // Free-flow automated drive-through monitoring (no mechanical barrier arm at ASU gate)
  // Pulses auxiliary signal/relay and flashes Green LED to confirm automated passage registration
  digitalWrite(RELAY_PIN, LOW); // Quick signal pulse
  digitalWrite(GREEN_LED, HIGH);
  digitalWrite(RED_LED, LOW);
  delay(100);
  digitalWrite(RELAY_PIN, HIGH);
  digitalWrite(GREEN_LED, LOW);
}

// =====================================================
// MULTI-READ RFID VALIDATION & COOLDOWN SUBSYSTEM
// Prioritizes correctness over speed:
// 1. Tag Detected
// 2. Multi-read validation (3/3 identical match within 2.5s window)
// 3. Confirm UID & Check previous entry/exit state
// 4. Create ONE transaction
// 5. Activate cooldown lockout (8s) & wait for vehicle to clear zone
// =====================================================

bool isTagInCooldown(const String &uid) {
  if (uid.length() == 0) return false;
  String dummyPlate = "";
  if (isUidInPresence(uid, dummyPlate)) {
    // Keep touching presence while tag continues to produce RF pulses in zone
    touchPresence(uid);
    return true;
  }
  return false;
}

void markTagInCooldown(const String &uid, const String &plate) {
  if (uid.length() == 0) return;
  registerPresence(uid, plate);
  Serial.printf("[COOLDOWN] Tag %s locked out (min cooldown: %lu ms, waiting for vehicle to leave zone)\n",
                uid.c_str(), MIN_COOLDOWN_MS);
}

bool uhfReadConfirmed(const String &uid) {
  if (uid.length() == 0) return false;
  unsigned long now = millis();

  // If vehicle is in active cooldown, ignore pulses
  if (isTagInCooldown(uid)) {
    return false;
  }

  // Instant mode: immediately confirm on the very first read
  if (REQUIRED_MATCHES <= 1) {
    Serial.printf("[UHF SCAN] Instant detection confirmed for UID: %s\n", uid.c_str());
    return true;
  }

  // Multi-read mode (if configured with REQUIRED_MATCHES > 1)
  if (valSession.candidateUid.length() > 0 &&
      (now - valSession.firstSeenMs <= VALIDATION_WINDOW_MS)) {
    if (valSession.candidateUid.equalsIgnoreCase(uid)) {
      valSession.matchCount++;
      valSession.totalAttempts++;
      valSession.lastReadMs = now;
      Serial.printf("[UHF MULTI-READ] Detection #%d/%d for UID: %s\n",
                    valSession.matchCount, REQUIRED_MATCHES, uid.c_str());

      // Show intermediate progress on LCD & short pip on buzzer
      char l1[17], l2[17];
      snprintf(l1, sizeof(l1), "VALIDATING %d/%d", valSession.matchCount, REQUIRED_MATCHES);
      snprintf(l2, sizeof(l2), "TAG: %-11.11s", uid.c_str());
      lcdShowFast(l1, l2);
      digitalWrite(BUZZER_PIN, HIGH);
      delay(15);
      digitalWrite(BUZZER_PIN, LOW);

      if (valSession.matchCount >= REQUIRED_MATCHES) {
        Serial.printf("[UHF VALIDATION] %d/%d MATCH CONFIRMED for UID: %s! Proceeding to state determination.\n",
                      REQUIRED_MATCHES, REQUIRED_MATCHES, uid.c_str());
        valSession.candidateUid = ""; // Reset session for next vehicle
        valSession.matchCount = 0;
        return true;
      }
      return false; // Waiting for next matching pulse
    } else {
      // Mismatch: a different UID entered reading zone; reset session
      Serial.printf("[UHF] New UID %s entered (previous was %s). Resetting window.\n",
                    uid.c_str(), valSession.candidateUid.c_str());
      valSession.candidateUid = uid;
      valSession.matchCount = 1;
      valSession.totalAttempts = 1;
      valSession.firstSeenMs = now;
      valSession.lastReadMs = now;
      return false;
    }
  } else {
    // New validation window started
    valSession.candidateUid = uid;
    valSession.matchCount = 1;
    valSession.totalAttempts = 1;
    valSession.firstSeenMs = now;
    valSession.lastReadMs = now;
    Serial.printf("[UHF MULTI-READ] Detection #1/%d for UID: %s (Window started)\n",
                  REQUIRED_MATCHES, uid.c_str());

    char l1[17], l2[17];
    snprintf(l1, sizeof(l1), "DETECTING... 1/%d", REQUIRED_MATCHES);
    snprintf(l2, sizeof(l2), "TAG: %-11.11s", uid.c_str());
    lcdShowFast(l1, l2);
    digitalWrite(BUZZER_PIN, HIGH);
    delay(20);
    digitalWrite(BUZZER_PIN, LOW);
    return false;
  }
}

// =======================
// SD CARD INITIALIZATION (HSPI)
// =======================
void initSDCard() {
  pinMode(SD_CS_PIN, OUTPUT);
  digitalWrite(SD_CS_PIN, HIGH);

  // Initialize dedicated HSPI bus for MicroSD Card (CS 13, MOSI 12, MISO 14, SCK 26)
  spiSD.begin(SD_SCK_PIN, SD_MISO_PIN, SD_MOSI_PIN, SD_CS_PIN);

  Serial.print("[SD] Initializing SD Card on HSPI (CS 13, MOSI 12, MISO 14, SCK 26)... ");

  if (SD.begin(SD_CS_PIN, spiSD)) {
    sdCardReady = true;
    Serial.println("OK! (SD Card Ready)");

    if (!SD.exists("/config")) {
      SD.mkdir("/config");
    }

    if (!SD.exists(WHITELIST_FILE)) {
      File f = SD.open(WHITELIST_FILE, FILE_WRITE);
      if (f) {
        f.println("UID,NAME,PLATE,ROLE,USER_TYPE,VEHICLE_ID,USER_ID,AUTHORIZED,IS_INSIDE,CPASS_ID");
        f.close();
      }
    }
  } else {
    sdCardReady = false;
    Serial.println("FAILED! (Check SD module wiring/card format)");
  }
}

String urlEncode(String str) {
  String encoded = "";
  char c;
  for (int i = 0; i < str.length(); i++) {
    c = str.charAt(i);
    if (isalnum(c))
      encoded += c;
    else if (c == ' ')
      encoded += "%20";
    else {
      char code[4];
      sprintf(code, "%%%02X", (unsigned char)c);
      encoded += code;
    }
  }
  return encoded;
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
        String newPass = devObj["target_pass"].isNull() ? "" : devObj["target_pass"].as<String>();
        newSsid.trim();
        newPass.trim();

        if (newSsid.length() > 0 && newSsid != "null" && newSsid != "target_pass") {
          Serial.println("\n🌐 [REMOTE CLOUD CMD] Received Wi-Fi Change request for SSID: '" +
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
            syncWhitelistToRam();
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
  http.setTimeout(4000);
  http.addHeader("apikey", SUPABASE_ANON);
  http.addHeader("Authorization", String("Bearer ") + SUPABASE_ANON);
  http.addHeader("Content-Type", "application/json");

  String sdStat = sdCardReady ? "MOUNTED (HSPI)" : "UNMOUNTED / ERROR";
  String payload =
      "{\"status\":\"ONLINE\",\"last_online\":\"now()\",\"wifi_ssid\":\"" +
      WiFi.SSID() + "\",\"ip_address\":\"" + WiFi.localIP().toString() + 
      "\",\"sd_status\":\"" + sdStat + 
      "\",\"rfid_status\":\"WIEGAND 26/34 READY\",\"led_status\":\"ACTIVE (🔴🟢)\",\"buzzer_status\":\"PWM READY\",\"lcd_status\":\"INITIALIZED (16x2)\",\"relay_status\":\"PASS SIGNAL ARMED\"}";
  // return=representation lets us detect a PATCH that matched 0 rows ("[]"),
  // which PostgREST otherwise reports as a silent success.
  http.addHeader("Prefer", "return=representation");
  int code = http.PATCH(payload);
  String patchResp = (code > 0) ? http.getString() : "";
  bool patched = (code >= 200 && code < 300 && patchResp != "[]");
  if (!patched) {
    Serial.printf("[HEARTBEAT] PATCH failed/0 rows (HTTP %d): %s\n", code,
                  patchResp.substring(0, 160).c_str());
    http.end();
    // Upsert keyed on the UNIQUE esp32_identifier column (not the UUID PK)
    String upsertUrl = String(SUPABASE_URL) +
                       "/rest/v1/devices?on_conflict=esp32_identifier";
    http.begin(secureClient, upsertUrl);
    http.setTimeout(4000);
    http.addHeader("apikey", SUPABASE_ANON);
    http.addHeader("Authorization", String("Bearer ") + SUPABASE_ANON);
    http.addHeader("Content-Type", "application/json");
    http.addHeader("Prefer", "resolution=merge-duplicates,return=minimal");
    String fullPayload =
        "{\"esp32_identifier\":\"" + String(GATE_ID) + "\",\"device_name\":\"" +
        String(GATE_NAME) + "\",\"gate_type\":\"" + String(GATE_TYPE) +
        "\",\"device_category\":\"" + String(GATE_CATEGORY) +
        "\",\"rfid_range\":\"" + String(RFID_FREQUENCY) +
        "\",\"device_location\":\"" + String(GATE_LOCATION) + "\"" +
        ",\"status\":\"ONLINE\",\"last_online\":\"now()\",\"wifi_ssid\":\"" +
        WiFi.SSID() + "\",\"ip_address\":\"" + WiFi.localIP().toString() +
        "\",\"sd_status\":\"" + sdStat + 
        "\",\"rfid_status\":\"WIEGAND 26/34 READY\",\"led_status\":\"ACTIVE (🔴🟢)\",\"buzzer_status\":\"PWM READY\",\"lcd_status\":\"INITIALIZED (16x2)\",\"relay_status\":\"PASS SIGNAL ARMED\"}";
    int upCode = http.POST(fullPayload);
    if (upCode >= 200 && upCode < 300) {
      Serial.println("[HEARTBEAT] Device row upserted -> ONLINE");
    } else {
      Serial.printf("[HEARTBEAT] Upsert FAILED (HTTP %d): %s\n", upCode,
                    http.getString().substring(0, 200).c_str());
      Serial.println("[HEARTBEAT] Hint: run supabase/schema.sql (needs "
                     "devices.ip_address column).");
    }
  } else {
    Serial.printf("[HEARTBEAT] ONLINE | RSSI %d dBm | Free heap %u bytes\n",
                  WiFi.RSSI(), ESP.getFreeHeap());
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
    f.println("PASSWORD=" + pass); // Local SD only — never sent to cloud
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
// NVS: SAVE Wi-Fi CREDENTIALS (only call after successful connection test)
// =======================
void saveWifiToNVS(String ssid, String pass) {
  preferences.begin("charrm_wifi", false);
  preferences.putString("ssid", ssid);
  preferences.putString("pass", pass);
  preferences.end();
  Serial.println("[NVS] Wi-Fi credentials saved. SSID: '" + ssid + "'");
}

// =====================================================
// 5. BLUETOOTH LOW ENERGY (BLE) PROVISIONING SUBSYSTEM
// =====================================================
void sendBleStatus(String status) {
  if (pBleCharacteristic && bleClientConnected) {
    pBleCharacteristic->setValue(status.c_str());
    pBleCharacteristic->notify();
    Serial.println("[BLE TX NOTIFY] " + status);
  }
}

class BleServerCallbacks : public BLEServerCallbacks {
  // Runs on the BLE stack task: only set flags, loop() handles LCD/buzzer.
  void onConnect(BLEServer* pServer) {
    bleClientConnected = true;
    bleEvtConnected = true;
  }

  void onDisconnect(BLEServer* pServer) {
    bleClientConnected = false;
    bleEvtDisconnected = true;
  }
};

class BleCharCallbacks : public BLECharacteristicCallbacks {
  void onWrite(BLECharacteristic* pCharacteristic) {
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
        // Set flag LAST so loop() never reads half-written credentials.
        // LCD, buzzer, BLE ack and the Wi-Fi test all happen in loop().
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

  Serial.println("[BLE] Initializing Bluetooth Provisioning Server (" + String(BLE_DEVICE_NAME) + ")...");
  lcdMsg("BLE SETUP MODE", "PAIR ON WEB/APP");

  // Coexistence: Wi-Fi must be in modem-sleep before the BT controller starts
  esp_wifi_set_ps(WIFI_PS_MIN_MODEM);

  // We only use BLE, so give the Classic-BT memory (~30KB) back to the heap.
  // This leaves more RAM for the HTTPS/TLS client talking to Supabase.
  static bool classicBtReleased = false;
  if (!classicBtReleased) {
    esp_bt_controller_mem_release(ESP_BT_MODE_CLASSIC_BT);
    classicBtReleased = true;
  }

  BLEDevice::init(BLE_DEVICE_NAME);
  BLEDevice::setMTU(517);
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

void pauseBleAdvertising() {
  if (bleServerRunning) {
    BLEDevice::getAdvertising()->stop();
    Serial.println("[BLE] Wi-Fi connected! Paused BLE advertising.");
  }
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
// 6. WI-FI CONNECTION CONTROLLER
// =====================================================
bool attemptWifiConnection(String testSsid, String testPass,
                           int timeoutSeconds) {
  if (testSsid.length() == 0)
    return false;

  Serial.println("\n===========================================");
  Serial.println("[WIFI] Target SSID: '" + testSsid + "'");
  if (testPass.length() > 0) {
    Serial.println("[WIFI] Password:    [" + String(testPass.length()) +
                   " characters]");
  } else {
    Serial.println("[WIFI] Password:    (NONE / OPEN NETWORK)");
  }
  Serial.println("===========================================");
  lcdMsg("CONNECTING WIFI", testSsid.substring(0, 16));

  // 1. Temporarily pause BLE advertising during Wi-Fi handshake to give 100% radio priority to Wi-Fi
  if (bleServerRunning) {
    BLEDevice::getAdvertising()->stop();
  }

  // 2. Station mode. Power-save is coexistence-aware: full power when BLE is
  // off, modem-sleep when BLE is on (required, otherwise the ESP32 aborts).
  WiFi.mode(WIFI_STA);
  applyWifiPowerSave();
  delay(100);

  // Always drop any previous association / pending background retry so the
  // new credentials are used cleanly (fixes switching networks while retrying)
  WiFi.disconnect(false, false);
  delay(200);

  WiFi.setAutoReconnect(true);

  if (testPass.length() > 0) {
    WiFi.begin(testSsid.c_str(), testPass.c_str());
  } else {
    WiFi.begin(testSsid.c_str());
  }

  Serial.print("[WIFI] Connecting to '" + testSsid + "'");
  int timeoutLoops = timeoutSeconds * 2; // Each loop is 500ms
  int elapsed = 0;
  while (WiFi.status() != WL_CONNECTED && elapsed < timeoutLoops) {
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
    lastWifiRetryMs = millis();
    applyWifiPowerSave();
    configTime(0, 0, "pool.ntp.org", "time.google.com"); // UTC clock for offline timestamps
    Serial.println("\n[OK] WiFi Connected! IP: " + WiFi.localIP().toString() +
                   " | RSSI: " + String(WiFi.RSSI()) + " dBm");
    lcdMsg("WIFI CONNECTED", WiFi.localIP().toString());
    delay(1000);

    // ── SAVE ONLY ON SUCCESS (test-then-save) ──
    saveWifiToNVS(testSsid, testPass);
    saveWifiToSD(testSsid, testPass);
    currentSsid = testSsid;
    currentPass = testPass;

    // Send positive acknowledgement to Web Bluetooth client
    sendBleStatus("{\"event\":\"CONNECTED\",\"ip\":\"" + WiFi.localIP().toString() + "\",\"rssi\":" + String(WiFi.RSSI()) + "}");
    pauseBleAdvertising();

    sendDeviceHeartbeat();
    return true;
  } else {
    wifiConnected = false;
    int st = WiFi.status();
    String errDetail = "Connection timeout";
    if (st == WL_NO_SSID_AVAIL) {
      errDetail = "SSID not found. Make sure router is broadcasting on 2.4GHz!";
    } else if (st == WL_CONNECT_FAILED) {
      errDetail = "Incorrect password (Code 4)";
    } else if (st == WL_DISCONNECTED) {
      errDetail = "Handshake timeout / weak signal (Code 6)";
    } else if (st == WL_IDLE_STATUS) {
      errDetail = "Wi-Fi idle / Radio contention (Code 0)";
    }

    Serial.println("\n[WARN] WiFi connection failed (Status: " + String(st) + " - " + errDetail + ")");
    lcdMsg("WIFI FAILED", "SD OFFLINE MODE");

    // Scan and list nearby 2.4GHz networks for diagnostics
    scanAndPrintNetworks();

    // Send exact, informative failure notification to Web Bluetooth client
    String failPayload = "{\"event\":\"FAILED\",\"error\":\"" + errDetail + "\",\"code\":" + String(st) + "}";
    sendBleStatus(failPayload);

    // Resume BLE advertising so user can retry or reconfigure
    if (bleServerRunning) {
      BLEDevice::startAdvertising();
    }

    delay(1000);
    return false;
  }
}

// =====================================================
// 7. REAL CAMPUS PRESENCE STATE MACHINE
// =====================================================
bool isTagCurrentlyInsideOnline(String uid) {
  String url =
      String(SUPABASE_URL) + "/rest/v1/transactions?rfid_uid=eq." +
      urlEncode(uid) +
      "&status=eq.AUTHORIZED&order=timestamp.desc&limit=1&select=direction";

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

  if (body.length() > 0 && body != "[]") {
    DynamicJsonDocument doc(512);
    if (deserializeJson(doc, body) == DeserializationError::Ok) {
      JsonArray arr = doc.as<JsonArray>();
      if (arr.size() > 0) {
        String lastDir = String(arr[0]["direction"] | "EXIT");
        return (lastDir == "ENTRY");
      }
    }
  }
  return false;
}

bool isTagCurrentlyInsideOffline(String uid) {
  if (!sdCardReady || !SD.exists(INSIDE_LIST_FILE))
    return false;
  File f = SD.open(INSIDE_LIST_FILE, FILE_READ);
  if (!f)
    return false;
  bool inside = false;
  while (f.available()) {
    String line = f.readStringUntil('\n');
    line.trim();
    if (line == uid) {
      inside = true;
      break;
    }
  }
  f.close();
  return inside;
}

void updateOfflinePresence(String uid, String newDirection) {
  if (!sdCardReady)
    return;
  if (newDirection == "ENTRY") {
    File f = SD.open(INSIDE_LIST_FILE, FILE_APPEND);
    if (f) {
      f.println(uid);
      f.close();
    }
  } else {
    if (!SD.exists(INSIDE_LIST_FILE))
      return;
    File f = SD.open(INSIDE_LIST_FILE, FILE_READ);
    if (!f)
      return;
    String updatedContent = "";
    while (f.available()) {
      String line = f.readStringUntil('\n');
      line.trim();
      if (line.length() > 0 && line != uid) {
        updatedContent += line + "\n";
      }
    }
    f.close();
    File fw = SD.open(INSIDE_LIST_FILE, FILE_WRITE);
    if (fw) {
      fw.print(updatedContent);
      fw.close();
    }
  }
}

// =====================================================
// OFFLINE WHITELIST VERIFICATION
// =====================================================
bool checkAuthorizationOffline(String uid) {
  card_found = false;
  card_authorized = false;
  card_name = "";
  card_plate = "";
  card_role = "";

  if (!sdCardReady || !SD.exists(WHITELIST_FILE)) {
    // If no SD whitelist cache exists yet, fallback: allow valid tag numbers
    return (uid.length() > 3);
  }

  File f = SD.open(WHITELIST_FILE, FILE_READ);
  if (!f)
    return (uid.length() > 3);

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

// =====================================================
// 8. VERIFICATION & TRANSACTION POSTING
// =====================================================
bool checkAuthorizationOnline(String uid) {
  card_found = false;
  card_authorized = false;
  card_name = "";
  card_plate = "";
  card_role = "";
  card_cpassId = "";
  card_userType = "VEHICLE";
  card_rfidType = "LONG_RANGE";
  card_vehicleId = "";
  card_userId = "";

  // 1. Check Special Tags (Visitor / Emergency)
  String specUrl = String(SUPABASE_URL) + "/rest/v1/special_tags?rfid_uid=eq." +
                   urlEncode(uid) +
                   "&select=type,label,description,rfid_type,user_type";
  HTTPClient httpSpec;
  httpSpec.begin(secureClient, specUrl);
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
        card_userType = String(specArr[0]["user_type"] | "VEHICLE");
        card_rfidType = String(specArr[0]["rfid_type"] | "LONG_RANGE");

        if (specType == "EMERGENCY") {
          card_name = String(specArr[0]["label"] | "Emergency Response");
          card_plate = "EMERGENCY";
        } else {
          card_name = String(specArr[0]["label"] | "Visitor Pass");
          card_plate = "VISITOR PASS";
        }
        httpSpec.end();
        return true;
      }
    }
  }
  httpSpec.end();

  // 2. Query Registered Users & Vehicles
  String url =
      String(SUPABASE_URL) + "/rest/v1/rfid_cards?rfid_uid=eq." +
      urlEncode(uid) +
      "&select=authorization_status,vehicle_id,user_id,rfid_type,user_type,"
      "vehicles(plate_number,vehicle_type,vehicle_model),"
      "users(full_name,role,role_detail,default_transit_mode,cpass_id,student_"
      "id)";

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
    String roleDetail = String(card["users"]["role_detail"] | "");
    if (card_role == "OTHERS" && roleDetail.length() > 0) {
      card_role = roleDetail;
    }
    card_cpassId = String(card["users"]["cpass_id"] | "");
    if (card_cpassId.length() == 0 || card_cpassId == "null") {
      card_cpassId = String(card["users"]["student_id"] | "");
    }
    if (card_cpassId == "null")
      card_cpassId = "";
    String defMode = String(card["users"]["default_transit_mode"] | "");
    if (defMode == "PEDESTRIAN") {
      card_userType = "PEDESTRIAN";
      card_rfidType = "CLOSE_RANGE";
    }
  }

  return card_authorized;
}

void syncWhitelistToRam() {
  if (!wifiConnected)
    return;
  Serial.println("\n[RAM CACHE] Syncing registered cards from Supabase...");

  // 1. Fetch special tags (Visitors / Emergency)
  String specUrl =
      String(SUPABASE_URL) +
      "/rest/v1/special_tags?select=rfid_uid,type,label,rfid_type,user_type";
  HTTPClient httpSpec;
  httpSpec.begin(secureClient, specUrl);
  httpSpec.setTimeout(4000);
  httpSpec.addHeader("apikey", SUPABASE_ANON);
  httpSpec.addHeader("Authorization", String("Bearer ") + SUPABASE_ANON);
  int sCode = httpSpec.GET();
  if (sCode == 200) {
    DynamicJsonDocument sDoc(2048);
    if (deserializeJson(sDoc, httpSpec.getString()) ==
        DeserializationError::Ok) {
      JsonArray arr = sDoc.as<JsonArray>();
      for (JsonObject item : arr) {
        String uid = String(item["rfid_uid"] | "");
        String sType = String(item["type"] | "VISITOR");
        String lbl =
            String(item["label"] | (sType == "EMERGENCY" ? "Emergency Responder"
                                                         : "Visitor Pass"));
        String uType = String(item["user_type"] | "VEHICLE");
        if (uid.length() > 0) {
          addCardToRam(uid, lbl,
                       (sType == "EMERGENCY" ? "EMERGENCY" : "VISITOR PASS"),
                       sType, uType, "", "", true);
        }
      }
    }
  }
  httpSpec.end();

  // 2. Fetch registered vehicle and user cards
  String url =
      String(SUPABASE_URL) +
      "/rest/v1/"
      "rfid_cards?select=rfid_uid,authorization_status,vehicle_id,user_id,rfid_"
      "type,user_type,vehicles(plate_number,vehicle_type,vehicle_model),users("
      "full_name,role,role_detail,cpass_id,student_id)&limit=100";
  HTTPClient http;
  http.begin(secureClient, url);
  http.setTimeout(4000);
  http.addHeader("apikey", SUPABASE_ANON);
  http.addHeader("Authorization", String("Bearer ") + SUPABASE_ANON);
  int code = http.GET();
  if (code == 200) {
    DynamicJsonDocument doc(8192);
    if (deserializeJson(doc, http.getString()) == DeserializationError::Ok) {
      JsonArray arr = doc.as<JsonArray>();
      for (JsonObject item : arr) {
        String uid = String(item["rfid_uid"] | "");
        String status = String(item["authorization_status"] | "PENDING");
        bool auth = (status == "AUTHORIZED");
        String vId = String(item["vehicle_id"] | "");
        String uId = String(item["user_id"] | "");
        String uType = String(item["user_type"] | "VEHICLE");
        String plate = "NO-PLATE";
        String name = "Cardholder";
        String role = "User";
        String cpass = "";

        if (!item["vehicles"].isNull()) {
          plate = String(item["vehicles"]["plate_number"] | "NO-PLATE");
        }
        if (!item["users"].isNull()) {
          name = String(item["users"]["full_name"] | "Registered User");
          role = String(item["users"]["role"] | "Student");
          String roleDetail = String(item["users"]["role_detail"] | "");
          if (role == "OTHERS" && roleDetail.length() > 0) {
            role = roleDetail;
          }
          cpass = String(item["users"]["cpass_id"] | "");
          if (cpass.length() == 0 || cpass == "null") {
            cpass = String(item["users"]["student_id"] | "");
          }
          if (cpass == "null")
            cpass = "";
        }

        if (uid.length() > 0) {
          addCardToRam(uid, name, plate, role, uType, vId, uId, auth, false,
                       cpass);
        }
      }
    }
  }
  http.end();

  // 3. Sync presence: query recent authorized transactions to know who is
  // currently inside
  String presUrl = String(SUPABASE_URL) +
                   "/rest/v1/"
                   "transactions?status=eq.AUTHORIZED&order=timestamp.desc&"
                   "limit=100&select=rfid_uid,direction";
  HTTPClient httpPres;
  httpPres.begin(secureClient, presUrl);
  httpPres.setTimeout(4000);
  httpPres.addHeader("apikey", SUPABASE_ANON);
  httpPres.addHeader("Authorization", String("Bearer ") + SUPABASE_ANON);
  int pCode = httpPres.GET();
  if (pCode == 200) {
    DynamicJsonDocument pDoc(4096);
    if (deserializeJson(pDoc, httpPres.getString()) ==
        DeserializationError::Ok) {
      JsonArray pArr = pDoc.as<JsonArray>();
      for (JsonObject pItem : pArr) {
        String pUid = String(pItem["rfid_uid"] | "");
        String pDir = String(pItem["direction"] | "EXIT");
        int idx = findCardInRam(pUid);
        if (idx != -1) {
          if (ramCards[idx].lastActionTime == 0) {
            ramCards[idx].isInside = (pDir == "ENTRY");
            ramCards[idx].lastActionTime = 1; // Mark resolved
          }
        }
      }
      for (int i = 0; i < ramCardCount; i++) {
        if (ramCards[i].lastActionTime == 1)
          ramCards[i].lastActionTime = 0;
      }
    }
  }
  httpPres.end();

  Serial.printf("[RAM CACHE] Successfully loaded %d registered card(s) into "
                "high-speed memory!\n",
                ramCardCount);
}

void processCloudQueue() {
  if (txQueueCount == 0 || !wifiConnected)
    return;
  // If Wiegand is currently receiving pulses, NEVER interrupt the reader!
  if (wiegandBitCount > 0)
    return;

  QueuedTransaction item = txQueue[txQueueHead];
  txQueueHead = (txQueueHead + 1) % MAX_TX_QUEUE;
  txQueueCount--;

  insertTransactionOnline(item.uid, item.direction, item.status, item.remarks,
                          item.vehicleId, item.userId, item.userType);
}

void insertTransactionOnline(String uid, String direction, String status,
                             String remarks, String vId, String uId,
                             String uType) {
  String url = String(SUPABASE_URL) + "/rest/v1/transactions";

  HTTPClient http;
  http.begin(secureClient, url);
  http.setTimeout(4000);
  http.addHeader("Content-Type", "application/json");
  http.addHeader("apikey", SUPABASE_ANON);
  http.addHeader("Authorization", String("Bearer ") + SUPABASE_ANON);
  http.addHeader("Prefer", "return=minimal");

  DynamicJsonDocument doc(512);
  doc["rfid_uid"] = uid;
  doc["direction"] = direction;
  doc["gate"] = GATE_ID;
  doc["status"] = status;
  doc["remarks"] = remarks;
  doc["user_type"] = (uType.length() > 0 ? uType : card_userType);
  doc["rfid_type"] = "LONG_RANGE";

  String targetVId = (vId.length() > 0 ? vId : card_vehicleId);
  String targetUId = (uId.length() > 0 ? uId : card_userId);

  if (targetVId.length() > 0 && targetVId != "null")
    doc["vehicle_id"] = targetVId;
  if (targetUId.length() > 0 && targetUId != "null")
    doc["user_id"] = targetUId;

  String body;
  serializeJson(doc, body);
  int httpCode = http.POST(body);
  Serial.printf("[CLOUD TX] Transaction POST for UID '%s' (%s) -> HTTP %d\n", uid.c_str(), direction.c_str(), httpCode);
  if (httpCode >= 200 && httpCode < 300) {
    Serial.println("  [OK] Successfully pushed transaction to Supabase Cloud!");
  } else {
    Serial.printf("  [WARN] Supabase POST failed with code %d. Falling back to SD offline buffer.\n", httpCode);
    saveOfflineTransactionSD(uid, direction, status, remarks, targetVId, targetUId, uType);
  }
  http.end();
}

// =====================================================
// OFFLINE TRANSACTION BUFFER (SD card, survives reboot)
// Line format: ts|uid|dir|status|remarks|vId|uId|uType
// =====================================================
static String cleanField(String s) {
  s.replace("|", "/");
  s.replace("\r", " ");
  s.replace("\n", " ");
  return s;
}

void saveOfflineTransactionSD(String uid, String dir, String status,
                              String remarks, String vId, String uId,
                              String uType) {
  if (!sdCardReady) {
    Serial.println(
        "[OFFLINE BUFFER] SD card not ready - scan could not be stored!");
    return;
  }
  File f = SD.open(OFFLINE_TX_FILE, FILE_APPEND);
  if (!f)
    return;
  f.println(isoUtcNow() + "|" + cleanField(uid) + "|" + dir + "|" + status +
            "|" + cleanField(remarks) + "|" + cleanField(vId) + "|" +
            cleanField(uId) + "|" + cleanField(uType));
  f.close();
  Serial.println("[OFFLINE BUFFER] Stored scan for " + uid + " (" + dir + ")");
}

// Same as insertTransactionOnline but returns success and can carry the
// original tap time.
bool insertTransactionOnlineTs(String uid, String direction, String status,
                               String remarks, String vId, String uId,
                               String uType, String ts) {
  HTTPClient http;
  http.begin(secureClient, String(SUPABASE_URL) + "/rest/v1/transactions");
  http.setTimeout(4000);
  http.addHeader("Content-Type", "application/json");
  http.addHeader("apikey", SUPABASE_ANON);
  http.addHeader("Authorization", String("Bearer ") + SUPABASE_ANON);
  http.addHeader("Prefer", "return=minimal");

  DynamicJsonDocument doc(640);
  doc["rfid_uid"] = uid;
  doc["direction"] = direction;
  doc["gate"] = GATE_ID;
  doc["status"] = status;
  doc["remarks"] = remarks;
  doc["user_type"] = uType;
  doc["rfid_type"] = "LONG_RANGE";
  if (ts.length() > 0)
    doc["timestamp"] = ts;
  if (vId.length() > 0 && vId != "null")
    doc["vehicle_id"] = vId;
  if (uId.length() > 0 && uId != "null")
    doc["user_id"] = uId;

  String body;
  serializeJson(doc, body);
  int code = http.POST(body);
  http.end();
  return code >= 200 && code < 300;
}

static String nextField(String &line) {
  int p = line.indexOf('|');
  String f;
  if (p < 0) {
    f = line;
    line = "";
  } else {
    f = line.substring(0, p);
    line = line.substring(p + 1);
  }
  return f;
}

// Uploads up to OFFLINE_FLUSH_BATCH buffered scans per call. Records that fail
// to upload stay on the card and are retried on the next pass.
void flushOfflineTransactions() {
  static unsigned long lastFlush = 0;
  if (!wifiConnected || !sdCardReady || !SD.exists(OFFLINE_TX_FILE))
    return;
  if (txQueueCount > 0 || wiegandBitCount > 0)
    return;
  if (millis() - lastFlush < 3000)
    return;
  lastFlush = millis();

  File in = SD.open(OFFLINE_TX_FILE, FILE_READ);
  if (!in)
    return;
  if (in.size() == 0) {
    in.close();
    SD.remove(OFFLINE_TX_FILE);
    return;
  }

  if (SD.exists(OFFLINE_TX_TMP))
    SD.remove(OFFLINE_TX_TMP);
  File out = SD.open(OFFLINE_TX_TMP, FILE_WRITE);
  if (!out) {
    in.close();
    return;
  }

  int sent = 0, kept = 0;
  bool halt = false;
  while (in.available()) {
    String line = in.readStringUntil('\n');
    line.trim();
    if (line.length() == 0)
      continue;

    if (!halt && sent < OFFLINE_FLUSH_BATCH) {
      String rest = line;
      String ts = nextField(rest), uid = nextField(rest), dir = nextField(rest),
             st = nextField(rest);
      String rem = nextField(rest), vId = nextField(rest),
             uId = nextField(rest), uType = nextField(rest);
      if (uType.length() == 0)
        uType = "VEHICLE";
      if (insertTransactionOnlineTs(uid, dir, st, "[OFFLINE SYNC] " + rem, vId,
                                    uId, uType, ts)) {
        sent++;
        continue;
      }
      halt = true; // network problem - keep this and everything after it
    }
    out.println(line);
    kept++;
  }
  in.close();
  out.close();

  SD.remove(OFFLINE_TX_FILE);
  if (kept > 0)
    SD.rename(OFFLINE_TX_TMP, OFFLINE_TX_FILE);
  else
    SD.remove(OFFLINE_TX_TMP);

  if (sent > 0)
    Serial.println("[OFFLINE BUFFER] Uploaded " + String(sent) +
                   " buffered scan(s), " + String(kept) + " remaining.");
}

// Called when Wi-Fi drops: move anything still waiting in RAM onto the SD card.
void spillRamQueueToSd() {
  while (txQueueCount > 0) {
    QueuedTransaction item = txQueue[txQueueHead];
    txQueueHead = (txQueueHead + 1) % MAX_TX_QUEUE;
    txQueueCount--;
    saveOfflineTransactionSD(item.uid, item.direction, item.status,
                             item.remarks, item.vehicleId, item.userId,
                             item.userType);
  }
}

// =====================================================
// 9. HIGH-SPEED SCAN EVENT DISPATCHER
// Fast in-memory RAM match (< 0.1ms), instant LCD & Serial
// =====================================================
void handleScannedTag(String uid, String altUid = "") {
  uid.trim();
  uid.toUpperCase();
  altUid.trim();
  altUid.toUpperCase();

  // Filter spurious zero IDs (e.g. noise pulse that produced all zeros)
  if (uid == "0" || uid == "0000000000" || uid.length() == 0) {
    return;
  }

  unsigned long scanStartUs = micros();

  // Multi-Tag Anti-Spam Check: Ignore duplicate pulses for this tag within 4s
  // window
  if (isTagInCooldown(uid) ||
      (altUid.length() > 0 && isTagInCooldown(altUid))) {
    return;
  }

  // Optional: only act once the tag has been read enough times in a short
  // window
  if (!uhfReadConfirmed(uid)) {
    return;
  }

  // 1. FAST IN-MEMORY RAM LOOKUP (0.05 ms)
  int cardIdx = findCardInRam(uid);
  if (cardIdx == -1 && altUid.length() > 0)
    cardIdx = findCardInRam(altUid);

  bool authorized = false;
  String finalUid = uid;
  String name = "";
  String plate = "";
  String role = "";
  String cpass = "";
  String uType = "VEHICLE";
  String vId = "";
  String uId = "";
  String direction = "ENTRY";
  bool isInside = false;

  if (cardIdx != -1) {
    // RAM CACHE HIT!
    authorized = ramCards[cardIdx].authorized;
    finalUid = ramCards[cardIdx].uid;
    name = ramCards[cardIdx].name;
    plate = ramCards[cardIdx].plate;
    role = ramCards[cardIdx].role;
    cpass = ramCards[cardIdx].cpassId;
    uType = ramCards[cardIdx].userType;
    vId = ramCards[cardIdx].vehicleId;
    uId = ramCards[cardIdx].userId;
    isInside = ramCards[cardIdx].isInside;

    if (authorized) {
      // 15-second Transit Anti-Passback Debounce:
      // While vehicle is passing through beam, ignore repeat pulses that would
      // log duplicate entry scans
      if (ramCards[cardIdx].lastActionTime > 0 &&
          (millis() - ramCards[cardIdx].lastActionTime < 15000)) {
        Serial.printf("  ⏳ [TRANSIT LOCKOUT] %s already granted ENTRY %lu ms "
                      "ago. Suppressing duplicate scan.\n",
                      plate.c_str(),
                      millis() - ramCards[cardIdx].lastActionTime);
        return;
      }

      // Dedicated Vehicle Entry Gate: All reads are strictly logged as ENTRY
      direction = "ENTRY";
      ramCards[cardIdx].isInside = true;
      ramCards[cardIdx].lastActionTime = millis();
    } else {
      // Unapproved / Denied tag -> ALWAYS ENTRY attempt, NEVER EXIT!
      direction = "ENTRY";
    }

  } else {
    // RAM CACHE MISS: Query Online (or Offline SD) and cache result
    if (wifiConnected) {
      authorized = checkAuthorizationOnline(uid);
      if (!authorized && altUid.length() > 0) {
        authorized = checkAuthorizationOnline(altUid);
        if (authorized)
          finalUid = altUid;
      }

      // Dedicated Vehicle Entry Gate: All reads are strictly logged as ENTRY
      direction = "ENTRY";
      if (authorized) {
        isInside = true;
      }
    } else {
      authorized = checkAuthorizationOffline(uid);
      if (!authorized && altUid.length() > 0) {
        authorized = checkAuthorizationOffline(altUid);
        if (authorized)
          finalUid = altUid;
      }

      direction = "ENTRY";
      if (authorized) {
        isInside = true;
      }
    }

    name = card_name;
    plate = card_plate;
    role = card_role;
    cpass = card_cpassId;
    uType = card_userType;
    vId = card_vehicleId;
    uId = card_userId;

    // Cache in RAM ONLY if authorized so unregistered tags never flip to EXIT
    if (authorized) {
      addCardToRam(finalUid, name, plate, role, uType, vId, uId, authorized,
                   isInside, cpass);
      int newIdx = findCardInRam(finalUid);
      if (newIdx != -1)
        ramCards[newIdx].lastActionTime = millis();
    }
  }

  // Mark this tag in the cooldown history table
  markTagInCooldown(uid, plate);
  if (altUid.length() > 0)
    markTagInCooldown(altUid, plate);

  unsigned long processTimeUs = micros() - scanStartUs;

  // 2. INSTANT LCD DISPLAY
  if (authorized) {
    char l1[17], l2[17];
    snprintf(l1, sizeof(l1), "[%-5s] %-8s", direction.c_str(), plate.c_str());
    snprintf(l2, sizeof(l2), "%-16.16s", name.c_str());
    lcdShowFast(l1, l2);
  } else {
    char l1[17], l2[17];
    snprintf(l1, sizeof(l1), "[DENIED] %-8s", uid.substring(0, 8).c_str());
    snprintf(l2, sizeof(l2), "UNREGISTERED TAG");
    lcdShowFast(l1, l2);
  }

  // 3. INSTANT SERIAL OUTPUT
  Serial.println("\n⚡⚡⚡ [ULTRA-FAST MULTI-SCAN DETECTED] ⚡⚡⚡");
  Serial.printf("  Card ID (Dec): %s%s\n", uid.c_str(),
                altUid.length() > 0 ? (" | Hex: " + altUid).c_str() : "");
  if (authorized) {
    Serial.printf("  Stakeholder:   %s (%s)\n", name.c_str(), role.c_str());
    if (cpass.length() > 0) {
      Serial.printf("  CPASS ID:      %s\n", cpass.c_str());
    }
    Serial.printf("  Vehicle:       %s [%s]\n", plate.c_str(), uType.c_str());
    Serial.printf("  Action:        [%s] Recorded (Now %s)\n",
                  direction.c_str(),
                  isInside ? "INSIDE CAMPUS" : "OUTSIDE CAMPUS");
    Serial.printf("  Status:        AUTHORIZED (Matched in %.2f ms)\n",
                  processTimeUs / 1000.0);
  } else {
    Serial.printf("  Action:        [ENTRY] ATTEMPT REJECTED (Unregistered)\n");
    Serial.printf(
        "  Status:        UNREGISTERED / DENIED (Checked in %.2f ms)\n",
        processTimeUs / 1000.0);
  }
  Serial.println("────────────────────────────────────────────────");

  // 4. AUDIO/VISUAL CONFIRMATION & BARRIER TRIGGER
  if (authorized) {
    triggerBarrier();
    beep(40, 1);
  } else {
    digitalWrite(RED_LED, HIGH);
    digitalWrite(GREEN_LED, LOW);
    beep(120, 1);
    digitalWrite(RED_LED, LOW);
  }

  // 5. ENQUEUE FOR ASYNC CLOUD SYNC (< 1 us) - or buffer to SD when offline
  {
    String remarks = authorized ? ("UHF Vehicle Entry (" + uType + ")")
                                : "Unregistered UHF Tag";
    String st = authorized ? "AUTHORIZED" : "DENIED";
    if (wifiConnected) {
      enqueueTransaction(finalUid, direction, st, remarks, vId, uId, uType);
    } else {
      saveOfflineTransactionSD(finalUid, direction, st, remarks, vId, uId,
                               uType);
    }
  }
  if (authorized) {
    updateOfflinePresence(finalUid, direction);
  }
}

// =====================================================
// 10. WIEGAND PULSE DECODER (Boland UHF RFID Reader)
// =====================================================
bool checkWiegandReader(String &outUid, String &outAltUid) {
  outUid = "";
  outAltUid = "";
  if (wiegandBitCount == 0)
    return false;

  // Wait until pulse transmission has completed (idle for > 15ms = 15,000us)
  if (micros() - lastWiegandActivityUs < 15000)
    return false;

  noInterrupts();
  uint64_t raw = wiegandRawBits;
  int bits = wiegandBitCount;
  uint32_t d0Pulses = countD0;
  uint32_t d1Pulses = countD1;
  wiegandRawBits = 0;
  wiegandBitCount = 0;
  countD0 = 0;
  countD1 = 0;
  interrupts();

  if (bits < 4 || raw == 0) {
    if (bits >= 4)
      Serial.printf("[WIEGAND NOISE] Ignored all-zero raw pulse (%d bits)\n",
                    bits);
    return false;
  }

  Serial.println("\n========================================");
  Serial.printf("[WIEGAND PULSE DETECTED] Total bits: %d | Raw Hex: 0x%llX\n",
                bits, (unsigned long long)raw);
  Serial.printf(
      "  Pulse Breakdown: D0 (Green) = %u pulses | D1 (White) = %u pulses\n",
      d0Pulses, d1Pulses);

  if (d1Pulses == 0 && d0Pulses > 0) {
    Serial.println("  ⚠️ [LINE ALERT] ZERO pulses on D1! The White wire is "
                   "either loose or not connected to GPIO 33!");
  } else if (d0Pulses == 0 && d1Pulses > 0) {
    Serial.println("  ⚠️ [LINE ALERT] ZERO pulses on D0! The Green wire is "
                   "either loose or not connected to GPIO 32!");
  }

  uint32_t cardNumber = 0;
  uint32_t facilityCode = 0;
  char hexFormatted[32];
  char decPadded[16];
  hexFormatted[0] = '\0';
  decPadded[0] = '\0';

  if (bits == 26) {
    // WG26 format: 1 even parity + 8 facility + 16 card number + 1 odd parity
    facilityCode = (raw >> 17) & 0xFF;
    cardNumber = (raw >> 1) & 0xFFFF;
    snprintf(hexFormatted, sizeof(hexFormatted), "%02X %02X %02X",
             (uint8_t)(facilityCode), (uint8_t)(cardNumber >> 8),
             (uint8_t)(cardNumber & 0xFF));
    snprintf(decPadded, sizeof(decPadded), "%010lu", (unsigned long)cardNumber);
    Serial.println("  Standard:      WG26 (26-bit)");
    Serial.println("  Facility:      " + String(facilityCode));
    Serial.println("  Card ID (Dec): " + String(cardNumber) +
                   " (Padded: " + String(decPadded) + ")");
    Serial.println("  Hex UID:       " + String(hexFormatted));

    outUid = String(cardNumber);
    outAltUid = String(decPadded);

  } else if (bits == 34) {
    // WG34 format: 1 even parity + 32 card number + 1 odd parity
    cardNumber = (raw >> 1) & 0xFFFFFFFF;
    snprintf(hexFormatted, sizeof(hexFormatted), "%02X %02X %02X %02X",
             (uint8_t)(cardNumber >> 24), (uint8_t)(cardNumber >> 16),
             (uint8_t)(cardNumber >> 8), (uint8_t)(cardNumber & 0xFF));
    snprintf(decPadded, sizeof(decPadded), "%010lu", (unsigned long)cardNumber);
    Serial.println("  Standard:      WG34 (34-bit)");
    Serial.println("  Card ID (Dec): " + String(cardNumber) +
                   " (10-Digit: " + String(decPadded) + ")");
    Serial.println("  Hex UID:       " + String(hexFormatted));

    // Support both 10-digit zero-padded (e.g. 0419670354) and regular decimal
    outUid = String(decPadded);
    outAltUid = String(cardNumber);

  } else {
    // Custom / other bit counts (e.g. 28, 32, 36)
    cardNumber = (uint32_t)(raw & 0xFFFFFFFF);
    snprintf(hexFormatted, sizeof(hexFormatted), "%02X %02X %02X %02X",
             (uint8_t)(cardNumber >> 24), (uint8_t)(cardNumber >> 16),
             (uint8_t)(cardNumber >> 8), (uint8_t)(cardNumber & 0xFF));
    snprintf(decPadded, sizeof(decPadded), "%010lu", (unsigned long)cardNumber);
    Serial.printf("  Standard:      %d-bit Wiegand\n", bits);
    Serial.println("  Card ID (Dec): " + String(cardNumber) +
                   " (Padded: " + String(decPadded) + ")");
    Serial.println("  Hex UID:       " + String(hexFormatted));

    outUid = String(decPadded);
    outAltUid = String(cardNumber);
  }

  Serial.println("========================================");
  return true;
}

// =====================================================
// 11. SETUP & INITIALIZATION
// =====================================================
void setup() {
  WRITE_PERI_REG(
      RTC_CNTL_BROWN_OUT_REG,
      0); // Prevent false brownout reboots during simultaneous WiFi TX + buzzer
  secureClient.setInsecure(); // Supabase HTTPS without root cert bundle (saves
                              // 35KB RAM, eliminates cert validation failure)
  Serial.begin(115200);
  delay(500);
  Serial.println("\n\n================================================");
  Serial.println("CHARRMPASS — Automated Vehicle UHF Monitor (~860–960 MHz)");
  Serial.println("Free-Flow Automated Drive-Through (No Mechanical Barrier)");
  Serial.println("================================================");

  // Peripherals
  pinMode(RED_LED, OUTPUT);
  pinMode(GREEN_LED, OUTPUT);
  pinMode(BUZZER_PIN, OUTPUT);
  pinMode(RELAY_PIN, OUTPUT);
  pinMode(BOOT_BUTTON_PIN, INPUT_PULLUP); // Onboard BOOT button

  digitalWrite(RED_LED, HIGH);
  digitalWrite(GREEN_LED, LOW);
  digitalWrite(RELAY_PIN, HIGH); // Relay OFF

  // LCD Init
  Wire.begin(21, 22);
  lcd.begin(16, 2);
  lcdMsg("CHARRMPASS v4.5", "BOOTING GATE...");
  delay(1000);

// Wiegand UHF Reader Interrupt Init on GPIO 32 (GREEN = D0) and GPIO 33 (WHITE
// = D1)
#if ENABLE_WIEGAND
  pinMode(WIEGAND_D0_PIN, INPUT_PULLUP);
  pinMode(WIEGAND_D1_PIN, INPUT_PULLUP);
  attachInterrupt(digitalPinToInterrupt(WIEGAND_D0_PIN), isrWiegandD0, FALLING);
  attachInterrupt(digitalPinToInterrupt(WIEGAND_D1_PIN), isrWiegandD1, FALLING);
  Serial.println("[WIEGAND] Boland UHF Reader initialized on GPIO 32 "
                 "(GREEN=D0) and GPIO 33 (WHITE=D1) with pull-ups.");
#endif

// SPI Backup Reader Init
#if ENABLE_SPI_MFRC522
  SPI.begin(18, 19, 23, 5);
  rfid.PCD_Init();
  Serial.println("[RFID] SPI MFRC522 Backup Reader initialized.");
#endif

  // MicroSD Memory Module Init on dedicated HSPI (CS 13, MOSI 12, MISO 14, SCK 26)
  initSDCard();

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
                   "'. Attempting connection...");
    bool ok = attemptWifiConnection(currentSsid, currentPass, 15);
    if (!ok) {
      Serial.println("[BOOT] Wi-Fi connection failed. Starting BLE server & Operating in Offline Mode.");
      startBleServer();
    } else {
      syncWhitelistToRam();
    }
  } else {
    Serial.println(
        "[BOOT] No saved Wi-Fi credentials found in NVS, SD, or code.");
    Serial.println("[BOOT] Starting BLE server for wireless Web provisioning...");
    startBleServer();
    scanAndPrintNetworks();
  }

  showReady();
}

// =====================================================
// 12. MAIN LOOP (HIGH-SPEED MULTI-TAG EVENT LOOP)
// =====================================================
void loop() {
  // ── ONBOARD BOOT BUTTON (GPIO 0): Hold for 3s to force Wi-Fi reset & enter BLE Setup Mode ──
  static unsigned long bootButtonPressStart = 0;
  if (digitalRead(BOOT_BUTTON_PIN) == LOW) {
    if (bootButtonPressStart == 0) {
      bootButtonPressStart = millis();
    } else if (millis() - bootButtonPressStart >= 3000) {
      Serial.println("\n🔘 [HARDWARE BUTTON] BOOT button held for 3s -> "
                     "Forcing Wi-Fi Reset & BLE Setup Mode!");
      lcdMsg("WIFI RESET", "BLE SETUP MODE");
      beep(150, 2);
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
    beep(100, 2);
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

  // ── BLE PROVISIONING: Handle new Wi-Fi credentials received over Bluetooth ──
  if (newWifiCredentialsReceived) {
    String newSsid = pendingBleSsid;
    String newPass = pendingBlePass;
    newWifiCredentialsReceived = false;

    Serial.println("\n[BLE PROVISION] Received SSID: '" + newSsid + "' (" +
                   String(newPass.length()) + " char password)");
    lcdMsg("RECEIVED WIFI", newSsid.substring(0, 16));
    beep(150, 1);
    sendBleStatus("{\"event\":\"SAVED\",\"ssid\":\"" + newSsid + "\"}");
    delay(300); // let the notify reach the browser before radio switches

    String prevSsid = currentSsid;
    String prevPass = currentPass;
    bool ok = attemptWifiConnection(newSsid, newPass, 25);
    if (ok) {
      syncWhitelistToRam();
    } else if (prevSsid.length() > 0 && prevSsid != newSsid) {
      // New credentials were wrong: fall back to the last working network so
      // the gate does not stay offline because of a typo.
      Serial.println("[BLE PROVISION] New Wi-Fi failed. Restoring previous "
                     "network '" + prevSsid + "'...");
      if (attemptWifiConnection(prevSsid, prevPass, 15)) {
        syncWhitelistToRam();
      }
    }
    lastWifiRetryMs = millis();
    showReady();
  }

  // Periodic Wi-Fi watchdog & Heartbeat
  if (WiFi.status() == WL_CONNECTED) {
    if (!wifiConnected) {
      wifiConnected = true;
      Serial.println("[WIFI] Reconnected to network! IP: " +
                     WiFi.localIP().toString());
      applyWifiPowerSave();
      configTime(0, 0, "pool.ntp.org", "time.google.com");
      pauseBleAdvertising();
      sendDeviceHeartbeat();
      syncWhitelistToRam();
      lastHeartbeat = millis();
      showReady();
    }
    if (millis() - lastHeartbeat >= HEARTBEAT_INTERVAL) {
      lastHeartbeat = millis();
      sendDeviceHeartbeat();
    }
  } else {
    if (wifiConnected) {
      wifiConnected = false;
      lastWifiRetryMs = millis();
      Serial.println("[WIFI] Lost Wi-Fi connection. Operating in Offline SD "
                     "Cache Mode...");
      spillRamQueueToSd();
      // Re-open BLE so the guard/admin can re-provision without a reboot.
      // (startBleServer() just restarts advertising if BLE is already up.)
      startBleServer();
      showReady();
    } else if (!bleServerRunning) {
      startBleServer();
      showReady();
    }

    // Non-blocking background reconnect to the saved network every 30s.
    // WiFi.begin() returns immediately, so UHF scanning is never paused.
    if (currentSsid.length() > 0 && !bleClientConnected &&
        millis() - lastWifiRetryMs >= WIFI_RETRY_INTERVAL) {
      lastWifiRetryMs = millis();
      Serial.println("[WIFI] Background retry -> '" + currentSsid + "'");
      WiFi.disconnect(false, false);
      if (currentPass.length() > 0) {
        WiFi.begin(currentSsid.c_str(), currentPass.c_str());
      } else {
        WiFi.begin(currentSsid.c_str());
      }
    }
  }

  // 1. Process asynchronous background cloud transactions whenever Wiegand is
  // idle
  processCloudQueue();
  flushOfflineTransactions();

  // 2. Periodic RAM Whitelist Sync from Supabase (every 5 minutes)
  if (wifiConnected &&
      (millis() - lastWhitelistSync >= WHITELIST_SYNC_INTERVAL)) {
    lastWhitelistSync = millis();
    syncWhitelistToRam();
  }

  // 3. Reset LCD display to ready screen after 3 seconds of idle time
  if (lastTagDisplayMillis > 0 && (millis() - lastTagDisplayMillis >= 3000)) {
    lastTagDisplayMillis = 0;
    showReady();
  }

  // Serial input: RESET: to clear credentials, or manual UID
  if (Serial.available() > 0) {
    String inputStr = Serial.readStringUntil('\n');
    inputStr.trim();
    if (inputStr.length() > 0) {

      // ── WIFI:<SSID>,<PASS>  → Test credentials and save ONLY on success ──
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

        Serial.println("\n[SERIAL PROVISION] Testing credentials for SSID: '" +
                       currentSsid + "'...");
        lcdMsg("TESTING WIFI...", currentSsid.substring(0, 16));
        beep(200, 1);
        bool ok = attemptWifiConnection(currentSsid, currentPass, 15);
        if (ok)
          syncWhitelistToRam();
        showReady();
        return;
      }

      // ── RESET: → Wipe NVS credentials and SD backup & start BLE ──
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
                       "Starting BLE Setup Mode...");
        lcdMsg("WIFI RESET", "BLE SETUP MODE");
        beep(400, 1);
        delay(500);
        WiFi.disconnect(true);
        wifiConnected = false;
        startBleServer();
        showReady();
        return;
      }

      // ── Manual tag UID for testing ──
      String testUid = inputStr;
      testUid.toUpperCase();
      Serial.println("[MANUAL] Simulating UHF tag: " + testUid);
      handleScannedTag(testUid);
    }
  }

// 4. Poll Boland Long-Range UHF Wiegand Reader (High Priority)
#if ENABLE_WIEGAND
  String wiegandUid = "";
  String wiegandAlt = "";
  if (checkWiegandReader(wiegandUid, wiegandAlt)) {
    handleScannedTag(wiegandUid, wiegandAlt);
  }
#endif

// 5. Poll Backup SPI Reader
#if ENABLE_SPI_MFRC522
  if (rfid.PICC_IsNewCardPresent() && rfid.PICC_ReadCardSerial()) {
    String uid = "";
    for (byte i = 0; i < rfid.uid.size; i++) {
      char h[4];
      sprintf(h, "%02X", rfid.uid.uidByte[i]);
      uid += h;
      if (i < rfid.uid.size - 1)
        uid += " ";
    }
    rfid.PICC_HaltA();
    rfid.PCD_StopCrypto1();

    handleScannedTag(uid);
  }
#endif

  // 6. Live Wiegand Hardware Diagnostics (Printed every 6 seconds)
  static unsigned long lastWiegandDiag = 0;
  if (millis() - lastWiegandDiag >= 6000) {
    lastWiegandDiag = millis();
    int d0_32 = digitalRead(WIEGAND_D0_PIN);
    int d1_33 = digitalRead(WIEGAND_D1_PIN);
    Serial.printf("[WIEGAND HARDWARE MONITOR] Wire Levels: G32(Green D0)=%s | "
                  "G33(White D1)=%s | Total Pulses Detected=%u\n",
                  d0_32 ? "HIGH" : "LOW (CHECK PULLUP)",
                  d1_33 ? "HIGH" : "LOW (CHECK PULLUP)", wiegandTotalPulses);
  }

  delayMicroseconds(200); // High-frequency polling (zero lag)
}
