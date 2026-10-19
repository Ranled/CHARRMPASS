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

// Hardware Pin Configuration — Boland UHF Reader UART Serial2 (Green=Reader TX -> GPIO16, White=Reader RX -> GPIO17)
#define ENABLE_UHF_SERIAL2 true
#define UHF_RX2_PIN 16 // GPIO 16 (RX2) -> Connect to Boland GREEN wire (Reader TX Output)
#define UHF_TX2_PIN 17 // GPIO 17 (TX2) -> Connect to Boland WHITE wire (Reader RX Input)
#define UHF_SERIAL_BAUD 9600 // Default: 9600 baud (switchable via Serial Monitor: 9600, 57600, 115200)
uint32_t currentUhfBaud = UHF_SERIAL_BAUD;
bool invertUhfSerial = true; // Inverted logic enabled by default on boot for Boland RS-232 serial
volatile uint32_t uhfTotalBytesReceived = 0;

// Hardware Pin Configuration — Boland UHF Reader (Wiegand)
#define ENABLE_WIEGAND true
#define WIEGAND_D0_PIN                                                         \
  32 // PURPLE wire: Wiegand Data 0 (D0) with internal pull-up
#define WIEGAND_D1_PIN                                                         \
  33 // GRAY wire: Wiegand Data 1 (D1) with internal pull-up

// -----------------------------------------------------
// WIEGAND DOUBLE-SCAN CONFIRMATION
// -----------------------------------------------------
// The exact same raw frame must be received this many times in a row (within
// the window) before the tag is processed. UHF readers repeat the tag
// continuously while it is in the field, so this adds almost no delay.
// Set WIEGAND_CONFIRM_READS to 1 for instant single-scan confirmation.
#define WIEGAND_CONFIRM_READS 1
#define WIEGAND_CONFIRM_WINDOW_MS 1000

// Interrupt-safe Wiegand pulse buffer with inter-line noise filtering
volatile uint64_t wiegandRawBits = 0;
volatile int wiegandBitCount = 0;
volatile uint32_t lastPulseD0Us = 0;
volatile uint32_t lastPulseD1Us = 0;
volatile uint32_t lastAnyPulseUs = 0;
volatile uint32_t lastWiegandActivityUs = 0;
volatile uint32_t countD0 = 0;
volatile uint32_t countD1 = 0;
volatile uint32_t wiegandTotalPulses = 0;

void IRAM_ATTR isrWiegandD0() {
  uint32_t now = micros();
  // Filter electrical ringing under 30us on the same line
  if (now - lastPulseD0Us < 30)
    return;
  // Filter simultaneous cross-line EMI spike under 20us
  if (now - lastAnyPulseUs < 20)
    return;

  lastPulseD0Us = now;
  lastAnyPulseUs = now;
  lastWiegandActivityUs = now;
  countD0++;
  wiegandTotalPulses++;
  if (wiegandBitCount < 64) {
    wiegandRawBits <<= 1;
    wiegandBitCount++;
  } else {
    wiegandBitCount++; // Track true frame length without corrupting 64-bit buffer
  }
}

void IRAM_ATTR isrWiegandD1() {
  uint32_t now = micros();
  // Filter electrical ringing under 30us on the same line
  if (now - lastPulseD1Us < 30)
    return;
  // Filter simultaneous cross-line EMI spike under 20us
  if (now - lastAnyPulseUs < 20)
    return;

  lastPulseD1Us = now;
  lastAnyPulseUs = now;
  lastWiegandActivityUs = now;
  countD1++;
  wiegandTotalPulses++;
  if (wiegandBitCount < 64) {
    wiegandRawBits = (wiegandRawBits << 1) | 1ULL;
    wiegandBitCount++;
  } else {
    wiegandBitCount++; // Track true frame length without corrupting 64-bit buffer
  }
}

#define ENABLE_SPI_MFRC522 true
#define RFID_SS_PIN 5
#define RFID_RST_PIN 27

#define SD_CS_PIN 13
#define SD_MOSI_PIN 12
#define SD_MISO_PIN 14
#define SD_SCK_PIN 26

#define RED_LED 2     // Traffic Light: RED (Standby / Idle / Denied)
#define YELLOW_LED 25 // Traffic Light: YELLOW (Offline Standby Blink / Processing)
#define GREEN_LED 4   // Traffic Light: GREEN (Done / Access Granted)
#define RELAY_PIN 25  // Auxiliary pass indicator / beacon relay (shared on GPIO 25)
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
bool bleStackInitialized = false;
bool bleClientConnected = false;
bool bleServerRunning = false;
bool inBleSetupMode = false; // True when BLE is open waiting for user to encode SSID & Password
volatile bool newWifiCredentialsReceived = false;
volatile bool bleForgetRequested = false;
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
unsigned long lastRemoteCmdCheck = 0;
const unsigned long REMOTE_CMD_CHECK_INTERVAL = 5000; // Poll cloud for Forget/Change Wi-Fi every 5s

// Persisted epoch time so offline UHF scans keep accurate timestamps across reboots
uint32_t savedEpoch = 0;
unsigned long bootMillisAtEpochLoad = 0;

void persistEpochIfValidUHF() {
  time_t now = time(nullptr);
  if (now > 1700000000) {
    savedEpoch = (uint32_t)now;
    bootMillisAtEpochLoad = millis();
    preferences.begin("charrm_time", false);
    preferences.putUInt("epoch", savedEpoch);
    preferences.end();
  }
}

// ESP32 shares ONE 2.4GHz radio between Wi-Fi and BLE. When the BT controller
// is running, ESP-IDF requires Wi-Fi modem sleep - WIFI_PS_NONE triggers
// "Should enable WiFi modem sleep when both WiFi and Bluetooth are enabled"
// and aborts (reboots) the chip. Only disable sleep when BLE is off.
void applyWifiPowerSave() {
  if (bleServerRunning || bleStackInitialized) {
    esp_wifi_set_ps(WIFI_PS_MIN_MODEM);
  } else {
    esp_wifi_set_ps(WIFI_PS_NONE);
  }
}

bool wifiConnected = false;
bool internetAvailable = true;
int consecutiveNetFails = 0;
unsigned long lastInternetProbeMs = 0;
const unsigned long INTERNET_PROBE_INTERVAL = 30000; // Check internet every 30s when down
bool sdCardReady = false;
unsigned long lastHeartbeat = 0;
const unsigned long HEARTBEAT_INTERVAL =
    60000; // 60 seconds periodic health check

const char *WHITELIST_FILE = "/uhf_whitelist.csv";
const char *INSIDE_LIST_FILE = "/currently_inside.csv";
const char *OFFLINE_TX_FILE = "/offline_txns.csv";
const char *WIFI_CONFIG_FILE = "/wifi.cfg";            // Primary SD Wi-Fi config
const char *WIFI_CONFIG_LEGACY = "/config/wifi.cfg";   // Backup SD Wi-Fi config
const char *OFFLINE_TX_TMP = "/offline_txns.tmp";

// -----------------------------------------------------
// OFFLINE BUFFER SETTINGS
// -----------------------------------------------------
#define OFFLINE_FLUSH_BATCH 5 // records uploaded per pass after reconnect

// Returns UTC ISO-8601 time (uses NTP if available, or NVS savedEpoch + millis() when offline)
String isoUtcNow() {
  time_t now = time(nullptr);
  if (now > 1700000000) {
    struct tm t;
    gmtime_r(&now, &t);
    char buf[25];
    strftime(buf, sizeof(buf), "%Y-%m-%dT%H:%M:%SZ", &t);
    return String(buf);
  }
  if (savedEpoch > 1700000000) {
    time_t est = (time_t)savedEpoch + ((millis() - bootMillisAtEpochLoad) / 1000);
    struct tm t;
    gmtime_r(&est, &t);
    char buf[25];
    strftime(buf, sizeof(buf), "%Y-%m-%dT%H:%M:%SZ", &t);
    return String(buf);
  }
  return "";
}

// =====================================================
// 1. CONFIGURABLE MULTI-READ VALIDATION & PRESENCE PARAMETERS
//    (Prioritizes Correctness over Speed)
// =====================================================
const int REQUIRED_MATCHES =
    1; // 1 = Instant once a frame is accepted. Wiegand frames are already
       // double-scan confirmed (WIEGAND_CONFIRM_READS) in
       // checkWiegandReader(), so the MFRC522/manual paths stay instant.
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
  char uid[18];
  char name[28];
  char plate[14];
  char role[14];
  char userType[12];
  char vehicleId[38];
  char userId[38];
  char cpassId[16];
  bool authorized;
  bool isInside; // TRUE if vehicle is currently inside campus, FALSE if outside
  unsigned long lastActionTime; // Millis timestamp of last ENTRY/EXIT to prevent repeat flip-flop
} RamCard;

#define MAX_RAM_CARDS 65
RamCard *ramCards = NULL;
int ramCardCount = 0;
unsigned long lastWhitelistSync = 0;
const unsigned long WHITELIST_SYNC_INTERVAL =
    300000; // Auto-sync RAM every 5 minutes

int findCardInRam(const String &uid) {
  if (ramCards == NULL) return -1;
  String cleanTarget = uid;
  cleanTarget.trim();
  while (cleanTarget.length() > 1 && cleanTarget.startsWith("0")) {
    cleanTarget = cleanTarget.substring(1);
  }

  for (int i = 0; i < ramCardCount; i++) {
    if (strcasecmp(ramCards[i].uid, uid.c_str()) == 0) {
      return i;
    }
    String cleanStored = String(ramCards[i].uid);
    cleanStored.trim();
    while (cleanStored.length() > 1 && cleanStored.startsWith("0")) {
      cleanStored = cleanStored.substring(1);
    }
    if (cleanStored.equalsIgnoreCase(cleanTarget)) {
      return i;
    }
  }
  return -1;
}

void addCardToRam(String uid, String name, String plate, String role,
                  String userType, String vId, String uId, bool auth,
                  bool inside = false, String cpass = "") {
  if (ramCards == NULL) return;
  int idx = findCardInRam(uid);
  if (idx != -1) {
    strncpy(ramCards[idx].name, name.c_str(), sizeof(ramCards[idx].name) - 1);
    strncpy(ramCards[idx].plate, plate.c_str(), sizeof(ramCards[idx].plate) - 1);
    strncpy(ramCards[idx].role, role.c_str(), sizeof(ramCards[idx].role) - 1);
    strncpy(ramCards[idx].userType, userType.c_str(), sizeof(ramCards[idx].userType) - 1);
    strncpy(ramCards[idx].vehicleId, vId.c_str(), sizeof(ramCards[idx].vehicleId) - 1);
    strncpy(ramCards[idx].userId, uId.c_str(), sizeof(ramCards[idx].userId) - 1);
    ramCards[idx].authorized = auth;
    ramCards[idx].isInside = inside;
    if (cpass.length() > 0)
      strncpy(ramCards[idx].cpassId, cpass.c_str(), sizeof(ramCards[idx].cpassId) - 1);
    return;
  }
  if (ramCardCount < MAX_RAM_CARDS) {
    RamCard &rc = ramCards[ramCardCount];
    memset(&rc, 0, sizeof(RamCard));
    strncpy(rc.uid, uid.c_str(), sizeof(rc.uid) - 1);
    strncpy(rc.name, name.c_str(), sizeof(rc.name) - 1);
    strncpy(rc.plate, plate.c_str(), sizeof(rc.plate) - 1);
    strncpy(rc.role, role.c_str(), sizeof(rc.role) - 1);
    strncpy(rc.userType, userType.c_str(), sizeof(rc.userType) - 1);
    strncpy(rc.vehicleId, vId.c_str(), sizeof(rc.vehicleId) - 1);
    strncpy(rc.userId, uId.c_str(), sizeof(rc.userId) - 1);
    rc.authorized = auth;
    rc.isInside = inside;
    rc.lastActionTime = 0;
    if (cpass.length() > 0)
      strncpy(rc.cpassId, cpass.c_str(), sizeof(rc.cpassId) - 1);
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
#define MAX_TX_QUEUE 12
QueuedTransaction txQueue[MAX_TX_QUEUE];
int txQueueHead = 0;
int txQueueTail = 0;
int txQueueCount = 0;

void saveOfflineTransactionSD(String uid, String dir, String status,
                              String remarks, String vId = "", String uId = "",
                              String uType = "VEHICLE");
void flushOfflineTransactions();
void spillRamQueueToSd();

void enqueueTransaction(String uid, String dir, String status, String remarks,
                        String vId, String uId, String uType) {
  if (txQueueCount >= MAX_TX_QUEUE) {
    // Spill oldest to SD offline buffer before dropping from RAM queue to guarantee 0 lost logs
    QueuedTransaction &old = txQueue[txQueueHead];
    saveOfflineTransactionSD(old.uid, old.direction, old.status, old.remarks,
                             old.vehicleId, old.userId, old.userType);
    txQueueHead = (txQueueHead + 1) % MAX_TX_QUEUE;
    txQueueCount--;
    Serial.println("[QUEUE] Queue full - spilled oldest transaction to SD offline log.");
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
String card_matchedUid = "";
String card_name = "";
String card_plate = "";
String card_role = "";
String card_cpassId = "";
String card_userType = "VEHICLE";
String card_rfidType = "LONG_RANGE";
String card_vehicleId = "";
String card_userId = "";
String calculatedDirection = "ENTRY";
unsigned long readyDisplayAtMillis = 0;

// Forward declarations
void sendDeviceHeartbeat();
void syncWhitelistToRam();
void loadWhitelistFromSD();
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
// Raw direct LCD print without triggering auto-reset timers
void lcdPrintRaw(String line1, String line2) {
  char b1[17], b2[17];
  snprintf(b1, sizeof(b1), "%-16.16s", line1.c_str());
  snprintf(b2, sizeof(b2), "%-16.16s", line2.c_str());
  lcd.setCursor(0, 0);
  lcd.print(b1);
  lcd.setCursor(0, 1);
  lcd.print(b2);
}

// Fast, flicker-free LCD write with automatic 1.2s status hold timer
void lcdShowFast(String line1, String line2) {
  lcdPrintRaw(line1, line2);
  readyDisplayAtMillis = millis() + 1200; // Hold scan status on LCD for 1.2s
}

void lcdMsg(String line1, String line2) { lcdPrintRaw(line1, line2); }

void setTrafficLight(bool red, bool yellow, bool green) {
  digitalWrite(RED_LED, red ? HIGH : LOW);
  digitalWrite(YELLOW_LED, yellow ? HIGH : LOW);
  digitalWrite(GREEN_LED, green ? HIGH : LOW);
}

void signalWifiConnectedSuccess() {
  Serial.println("[WIFI] Connection Successful! 3 Green Blinks...");
  setTrafficLight(false, false, false);

  for (int i = 0; i < 3; i++) {
    digitalWrite(GREEN_LED, HIGH);
    digitalWrite(BUZZER_PIN, HIGH);
    delay(100);
    digitalWrite(BUZZER_PIN, LOW);
    delay(50);
    digitalWrite(GREEN_LED, LOW);
    delay(150);
  }

  // Standby: RED ON
  setTrafficLight(true, false, false);
}

void showReady() {
  if (inBleSetupMode) {
    if (bleClientConnected) {
      lcdPrintRaw("BLUETOOTH PAIRED", "ENCODE SSID&PASS");
    } else {
      lcdPrintRaw("[OFFLINE] BLE ON", "PAIR TO SET WIFI");
    }
    setTrafficLight(false, true, false);
    return;
  }

  if (wifiConnected && internetAvailable) {
    lcdPrintRaw("UHF VEHICLE ENT", "AUTO DRIVE-THRU");
    // Standby: Solid RED when Online
    setTrafficLight(true, false, false);
  } else {
    if (bleServerRunning) {
      lcdPrintRaw("[OFFLINE] BLE ON", "PAIR TO SET WIFI");
    } else {
      lcdPrintRaw("[OFFLINE] ENTRY", "AUTO DRIVE-THRU");
    }
    // Standby: Blinking Yellow when Offline (Traffic light initialized to Yellow, pulsed in loop)
    setTrafficLight(false, true, false);
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
  // Enable internal pull-up on MISO (GPIO 14) so DO line never floats during SPI mode switch
  pinMode(SD_MISO_PIN, INPUT_PULLUP);
  delay(20);

  // Initialize dedicated HSPI bus for MicroSD Card (CS 13, MOSI 12, MISO 14, SCK 26)
  spiSD.begin(SD_SCK_PIN, SD_MISO_PIN, SD_MOSI_PIN, SD_CS_PIN);

  // Wake up SD card into native SPI mode: send 80+ dummy clock cycles (12 bytes of 0xFF) with CS HIGH
  digitalWrite(SD_CS_PIN, HIGH);
  spiSD.beginTransaction(SPISettings(400000, MSBFIRST, SPI_MODE0));
  for (int i = 0; i < 12; i++) {
    spiSD.transfer(0xFF);
  }
  spiSD.endTransaction();
  delay(10);

  Serial.print("[SD] Initializing SD Card on HSPI (CS 13, MOSI 12, MISO 14, SCK 26)... ");

  // Try 4MHz first, then fallback to 1MHz and 400kHz for long jumper wires / level shifters
  const uint32_t sdSpeeds[] = {4000000UL, 1000000UL, 400000UL};
  sdCardReady = false;
  for (int attempt = 0; attempt < 3; attempt++) {
    if (attempt > 0) {
      SD.end();
      digitalWrite(SD_CS_PIN, HIGH);
      delay(80);
      spiSD.beginTransaction(SPISettings(400000, MSBFIRST, SPI_MODE0));
      for (int i = 0; i < 12; i++) spiSD.transfer(0xFF);
      spiSD.endTransaction();
      delay(20);
    }
    if (SD.begin(SD_CS_PIN, spiSD, sdSpeeds[attempt])) {
      sdCardReady = true;
      Serial.printf("OK! (SD Card Ready @ %lu kHz)\n", sdSpeeds[attempt] / 1000UL);
      break;
    }
  }

  if (sdCardReady) {
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

    loadWhitelistFromSD();
  } else {
    Serial.println("FAILED! (Check SD module 5V power / CS=13, MOSI=12, MISO=14, SCK=26 / FAT32 format)");
  }
}

void loadWhitelistFromSD() {
  ramCardCount = 0;
  if (ramCards == NULL) {
    ramCards = (RamCard *)calloc(MAX_RAM_CARDS, sizeof(RamCard));
  }
  if (!ramCards || !sdCardReady || !SD.exists(WHITELIST_FILE)) return;
  File f = SD.open(WHITELIST_FILE, FILE_READ);
  if (!f) return;
  int loaded = 0;
  while (f.available() && ramCardCount < MAX_RAM_CARDS) {
    String line = f.readStringUntil('\n');
    line.trim();
    if (line.length() == 0 || line.startsWith("UID,")) continue;
    int p1 = line.indexOf(',');
    if (p1 <= 0) continue;
    String uid = line.substring(0, p1);
    int p2 = line.indexOf(',', p1 + 1);
    String name = (p2 > 0) ? line.substring(p1 + 1, p2) : "User";
    int p3 = (p2 > 0) ? line.indexOf(',', p2 + 1) : -1;
    String plate = (p3 > 0) ? line.substring(p2 + 1, p3) : "NO-PLATE";
    int p4 = (p3 > 0) ? line.indexOf(',', p3 + 1) : -1;
    String role = (p4 > 0) ? line.substring(p3 + 1, p4) : "Resident";
    int p5 = (p4 > 0) ? line.indexOf(',', p4 + 1) : -1;
    String uType = (p5 > 0) ? line.substring(p4 + 1, p5) : "VEHICLE";
    int p6 = (p5 > 0) ? line.indexOf(',', p5 + 1) : -1;
    String vId = (p6 > 0) ? line.substring(p5 + 1, p6) : "";
    int p7 = (p6 > 0) ? line.indexOf(',', p6 + 1) : -1;
    String uId = (p7 > 0) ? line.substring(p6 + 1, p7) : "";
    int p8 = (p7 > 0) ? line.indexOf(',', p7 + 1) : -1;
    bool auth = (p8 > 0) ? (line.substring(p7 + 1, p8) == "true") : true;
    int p9 = (p8 > 0) ? line.indexOf(',', p8 + 1) : -1;
    bool inside = (p9 > 0) ? (line.substring(p8 + 1, p9) == "true") : false;
    String cpass = (p9 > 0) ? line.substring(p9 + 1) : "";

    addCardToRam(uid, name, plate, role, uType, vId, uId, auth, inside, cpass);
    loaded++;
  }
  f.close();
  if (loaded > 0) {
    Serial.printf("[SD CACHE] Loaded %d card(s) from MicroSD into high-speed RAM Cache!\n", loaded);
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

// Forward declarations
void startBleServer();
void stopBleAndFreeRam();
void forgetWifiAndStartBle();
bool attemptWifiConnection(String testSsid, String testPass, int timeoutSeconds);
void syncWhitelistToRam();
void showReady();
void saveWifiToSD(String ssid, String pass);
void saveWifiToNVS(String ssid, String pass);

// =======================
// REMOTE CLOUD COMMAND POLLER (Forget Wi-Fi / Reconfigure Wi-Fi)
// =======================
bool checkRemoteWifiCommand() {
  if (WiFi.status() != WL_CONNECTED)
    return false;
  if (wiegandBitCount > 0)
    return false;

  secureClient.stop();
  secureClient.setInsecure();
  secureClient.setHandshakeTimeout(3);

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
    checkHttp.end();
    secureClient.stop();
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
          // ── CASE A: REMOTE "FORGET WI-FI" COMMAND FROM WEB DASHBOARD ──
          if (newSsid == "__FORGET__" || newSsid.equalsIgnoreCase("FORGET") || newSsid.equalsIgnoreCase("RESET")) {
            Serial.println("\n🌐 [REMOTE CLOUD CMD] Received FORGET WI-FI command from Admin Dashboard!");
            HTTPClient clearHttp;
            String clearUrl = String(SUPABASE_URL) + "/rest/v1/devices?esp32_identifier=eq." + String(GATE_ID);
            clearHttp.begin(secureClient, clearUrl);
            clearHttp.setTimeout(3000);
            clearHttp.addHeader("apikey", SUPABASE_ANON);
            clearHttp.addHeader("Authorization", String("Bearer ") + SUPABASE_ANON);
            clearHttp.addHeader("Content-Type", "application/json");
            clearHttp.PATCH("{\"target_ssid\":null,\"target_pass\":null,\"status\":\"OFFLINE\",\"wifi_ssid\":\"BLE SETUP MODE\",\"ip_address\":\"0.0.0.0\"}");
            clearHttp.end();
            secureClient.stop();

            forgetWifiAndStartBle();
            return true;
          }

          // ── CASE B: REMOTE WI-FI CHANGE COMMAND ──
          Serial.println("\n🌐 [REMOTE CLOUD CMD] Received Wi-Fi Change request for SSID: '" + newSsid + "'");
          lcdMsg("REMOTE WIFI CMD", newSsid.substring(0, 16));

          HTTPClient clearHttp;
          String clearUrl = String(SUPABASE_URL) + "/rest/v1/devices?esp32_identifier=eq." + String(GATE_ID);
          clearHttp.begin(secureClient, clearUrl);
          clearHttp.setTimeout(3000);
          clearHttp.addHeader("apikey", SUPABASE_ANON);
          clearHttp.addHeader("Authorization", String("Bearer ") + SUPABASE_ANON);
          clearHttp.addHeader("Content-Type", "application/json");
          clearHttp.PATCH("{\"target_ssid\":null,\"target_pass\":null}");
          clearHttp.end();
          secureClient.stop();

          // Save to SD card & NVS first
          saveWifiToSD(newSsid, newPass);
          saveWifiToNVS(newSsid, newPass);

          bool ok = attemptWifiConnection(newSsid, newPass, 20);
          if (ok) {
            syncWhitelistToRam();
          } else {
            Serial.println("[REMOTE CMD] Failed to connect to new Wi-Fi. Reconnecting to saved network...");
            if (currentSsid.length() > 0 && currentSsid != newSsid) {
              saveWifiToSD(currentSsid, currentPass);
              saveWifiToNVS(currentSsid, currentPass);
              attemptWifiConnection(currentSsid, currentPass, 15);
            } else {
              startBleServer();
            }
          }
          showReady();
          return true;
        }
      }
    }
    return false;
  }
  checkHttp.end();
  secureClient.stop();
  return false;
}

void sendDeviceHeartbeat() {
  if (WiFi.status() != WL_CONNECTED)
    return;

  persistEpochIfValidUHF();

  // 1. Check for Over-The-Air Wi-Fi Reconfiguration / Forget Commands first
  if (checkRemoteWifiCommand())
    return;

  secureClient.stop();
  secureClient.setInsecure();
  secureClient.setHandshakeTimeout(4);

  // 2. Report Live Online Status, Wi-Fi SSID, and IP Address to Cloud
  HTTPClient http;
  String url = String(SUPABASE_URL) + "/rest/v1/devices?esp32_identifier=eq." +
               String(GATE_ID);
  http.begin(secureClient, url);
  http.setTimeout(3000);
  http.addHeader("apikey", SUPABASE_ANON);
  http.addHeader("Authorization", String("Bearer ") + SUPABASE_ANON);
  http.addHeader("Content-Type", "application/json");

  String sdStat = sdCardReady ? "MOUNTED (HSPI)" : "UNMOUNTED / ERROR";
  String payload =
      "{\"status\":\"ONLINE\",\"last_online\":\"now()\",\"wifi_ssid\":\"" +
      WiFi.SSID() + "\",\"ip_address\":\"" + WiFi.localIP().toString() + 
      "\",\"sd_status\":\"" + sdStat + 
      "\",\"rfid_status\":\"WIEGAND 26/34 READY\",\"led_status\":\"ACTIVE (🔴🟢)\",\"buzzer_status\":\"PWM READY\",\"lcd_status\":\"INITIALIZED (16x2)\",\"relay_status\":\"PASS SIGNAL ARMED\"}";
  http.addHeader("Prefer", "return=representation");
  int code = http.PATCH(payload);
  String patchResp = (code > 0) ? http.getString() : "";
  http.end();
  secureClient.stop();
  bool patched = (code >= 200 && code < 300 && patchResp != "[]");
  if (!patched) {
    // Upsert keyed on the UNIQUE esp32_identifier column (not the UUID PK)
    String upsertUrl = String(SUPABASE_URL) +
                       "/rest/v1/devices?on_conflict=esp32_identifier";
    http.begin(secureClient, upsertUrl);
    http.setTimeout(3000);
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
    http.end();
    secureClient.stop();
    if (upCode >= 200 && upCode < 300) {
      Serial.println("[HEARTBEAT] Device row upserted -> ONLINE");
      internetAvailable = true;
      consecutiveNetFails = 0;
    }
  } else {
    internetAvailable = true;
    consecutiveNetFails = 0;
    Serial.printf("[HEARTBEAT] ONLINE | RSSI %d dBm | Free heap %u bytes\n",
                  WiFi.RSSI(), ESP.getFreeHeap());
  }
}

// =======================
// SD CARD: SAVE Wi-Fi CREDENTIALS (PRIMARY + BACKUP)
// =======================
void saveWifiToSD(String ssid, String pass) {
  if (!sdCardReady) {
    Serial.println("[SD] SD card not mounted — skipping SD Wi-Fi save");
    return;
  }
  // 1. Save to primary root file (/wifi.cfg)
  if (SD.exists(WIFI_CONFIG_FILE)) SD.remove(WIFI_CONFIG_FILE);
  File f1 = SD.open(WIFI_CONFIG_FILE, FILE_WRITE);
  if (f1) {
    f1.println("SSID=" + ssid);
    f1.println("PASSWORD=" + pass);
    f1.flush();
    f1.close();
    Serial.println("[SD] Wi-Fi credentials saved to " + String(WIFI_CONFIG_FILE));
  }
  // 2. Save to /config/wifi.cfg backup
  if (!SD.exists("/config")) SD.mkdir("/config");
  if (SD.exists(WIFI_CONFIG_LEGACY)) SD.remove(WIFI_CONFIG_LEGACY);
  File f2 = SD.open(WIFI_CONFIG_LEGACY, FILE_WRITE);
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
  const char *path = SD.exists(WIFI_CONFIG_FILE) ? WIFI_CONFIG_FILE :
                     (SD.exists(WIFI_CONFIG_LEGACY) ? WIFI_CONFIG_LEGACY : NULL);
  if (!path)
    return false;
  File f = SD.open(path, FILE_READ);
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
  outSsid.trim();
  outPass.trim();
  if (outSsid.length() > 0) {
    Serial.println("[SD] Loaded Wi-Fi credentials from SD (" + String(path) + "): '" + outSsid + "'");
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
    return;
  }

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

static String bleRxBuffer = "";
static unsigned long lastBleRxMs = 0;

class BleCharCallbacks : public BLECharacteristicCallbacks {
  void onWrite(BLECharacteristic* pCharacteristic) {
    String chunk = pCharacteristic->getValue().c_str();
    if (chunk.length() == 0) return;

    // Clear stale partial buffer if more than 3 seconds elapsed between chunks
    if (millis() - lastBleRxMs > 3000) {
      bleRxBuffer = "";
    }
    lastBleRxMs = millis();
    bleRxBuffer += chunk;

    String rxValue = bleRxBuffer;
    rxValue.trim();
    Serial.println("[BLE RX] Chunk (" + String(chunk.length()) + "B), Buffer: " + rxValue);

    // If JSON starts with '{' but hasn't received the closing '}' yet, wait for next BLE packet
    if (rxValue.startsWith("{") && !rxValue.endsWith("}")) {
      Serial.println("[BLE RX] Waiting for remaining JSON chunk...");
      return;
    }
    bleRxBuffer = ""; // Complete frame received

    // 1. Check for direct BLE "FORGET" / "RESET" command from Web App
    if (rxValue.equalsIgnoreCase("FORGET") || rxValue.equalsIgnoreCase("RESET") || rxValue.equalsIgnoreCase("RESET:")) {
      bleForgetRequested = true;
      return;
    }

    DynamicJsonDocument doc(512);
    DeserializationError err = deserializeJson(doc, rxValue);
    String newSsid = "";
    String newPass = "";
    if (err == DeserializationError::Ok) {
      String cmd = String(doc["cmd"] | doc["action"] | "");
      if (cmd.equalsIgnoreCase("FORGET") || cmd.equalsIgnoreCase("RESET")) {
        bleForgetRequested = true;
        return;
      }
      newSsid = String(doc["ssid"] | "");
      newPass = String(doc["pass"] | "");
    } else if (!rxValue.startsWith("{")) {
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

    if (newSsid == "__FORGET__" || newSsid.equalsIgnoreCase("FORGET")) {
      bleForgetRequested = true;
      return;
    }

    if (newSsid.length() > 0 && !newWifiCredentialsReceived) {
      pendingBleSsid = newSsid;
      pendingBlePass = newPass;
      newWifiCredentialsReceived = true;
    }
  }
};

void stopBleAndFreeRam() {
  if (!bleStackInitialized && !bleServerRunning) return;
  Serial.println("[BLE->WIFI] Stopping BLE stack to free internal RAM for Wi-Fi task...");
  Serial.flush();
  if (pBleServer && bleClientConnected) {
    pBleServer->disconnect(pBleServer->getConnId());
    delay(150);
  }
  if (bleServerRunning) {
    BLEDevice::getAdvertising()->stop();
    bleServerRunning = false;
  }
  delay(100);
  // Release Bluedroid + BT controller heap (~105KB DRAM) cleanly
  BLEDevice::deinit(true);
  btStop();
  pBleServer = NULL;
  pBleCharacteristic = NULL;
  bleStackInitialized = false;
  bleClientConnected = false;
  delay(250);
  Serial.printf("[BLE->WIFI] BLE stopped. Free heap: %u bytes (Max block: %u bytes)\n",
                ESP.getFreeHeap(), ESP.getMaxAllocHeap());
  Serial.flush();
}

void initBleStackOnce() {
  if (bleStackInitialized)
    return;

  Serial.println("[BLE] Initializing Bluetooth Stack (" + String(BLE_DEVICE_NAME) + ")...");
  Serial.flush();

  delay(100); // Allow 12V buck converter rail to settle before BLE RF init
  BLEDevice::init(BLE_DEVICE_NAME);
  BLEDevice::setMTU(517);
  delay(100);
  lcd.begin(16, 2); // Recover I2C LCD in case buck converter dipped during RF init

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
  pAdvertising->stop();

  // Primary Advertisement Packet (<= 31 bytes limit!): Flags (3B) + Name (20B) = 23 bytes
  BLEAdvertisementData oAdvertisementData = BLEAdvertisementData();
  oAdvertisementData.setFlags(0x06); // General Discoverable + BR/EDR Not Supported
  oAdvertisementData.setName(BLE_DEVICE_NAME);
  pAdvertising->setAdvertisementData(oAdvertisementData);

  // Scan Response Packet (<= 31 bytes limit!): Complete 128-bit Service UUID (18B) = 18 bytes
  BLEAdvertisementData oScanResponseData = BLEAdvertisementData();
  oScanResponseData.setCompleteServices(BLEUUID(BLE_SERVICE_UUID));
  pAdvertising->setScanResponseData(oScanResponseData);

  pAdvertising->addServiceUUID(BLE_SERVICE_UUID);
  pAdvertising->setScanResponse(true);
  pAdvertising->setMinPreferred(0x06);
  pAdvertising->setMinPreferred(0x12);

  bleStackInitialized = true;
  Serial.println("[BLE] Bluetooth GATT Server & Service initialized.");
  Serial.flush();
}

void startBleServer() {
  Serial.println("[BLE] Initializing Bluetooth Provisioning Server (" + String(BLE_DEVICE_NAME) + ")...");
  Serial.flush();
  lcdMsg("BLE SETUP MODE", "PAIR ON WEB/APP");

  // Always ensure Wi-Fi driver is OFF before running BLE so Wi-Fi and BLE never compete for RAM
  if (WiFi.getMode() != WIFI_OFF) {
    Serial.println("[BLE] Turning off Wi-Fi driver to dedicate RAM & 2.4GHz radio to Bluetooth...");
    secureClient.stop();
    WiFi.setAutoReconnect(false);
    WiFi.disconnect(true, false);
    WiFi.mode(WIFI_OFF);
    delay(250);
  }
  wifiConnected = false;

  // CRITICAL FIX: Free the 20KB ramCards buffer before initializing Bluedroid BLE!
  // Otherwise, after 3 failed Wi-Fi attempts, BLEDevice::init() runs out of contiguous DRAM
  // and crashes/reboots the ESP32! While BLE is open in Offline Mode, vehicle tags are
  // verified directly from the SD card (/uhf_whitelist.csv) via checkAuthorizationOffline().
  if (!bleStackInitialized && ESP.getMaxAllocHeap() < 75000) {
    if (ramCards != NULL) {
      Serial.println("[BLE] Releasing 20KB RAM cache so Bluedroid has contiguous heap (SD offline cache active)...");
      free(ramCards);
      ramCards = NULL;
      ramCardCount = 0;
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
  Serial.println("[BLE] >>> BROADCASTING AS '" + String(BLE_DEVICE_NAME) + "' (Ready for Web Pairing) <<<");
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
// FORGET WI-FI & ENTER BLUETOOTH PROVISIONING MODE
// Flow: Forget Wi-Fi -> Wipe SD & NVS -> Turn OFF Wi-Fi -> Turn ON Bluetooth
// =======================
void forgetWifiAndStartBle() {
  Serial.println("\n=======================================================");
  Serial.println("🔄 [FORGET WI-FI] Wiping saved Wi-Fi credentials (SD & NVS)");
  Serial.println("=======================================================");
  inBleSetupMode = true;
  lcdMsg("FORGETTING WIFI", "STARTING BLE...");
  beep(150, 2);

  secureClient.stop();
  WiFi.setAutoReconnect(false);

  // 1. Wipe NVS Wi-Fi credentials
  preferences.begin("charrm_wifi", false);
  preferences.clear();
  preferences.end();
  Serial.println("[FORGET WI-FI] NVS 'charrm_wifi' cleared.");

  // 2. Wipe SD Card Wi-Fi config files (/wifi.cfg & /config/wifi.cfg)
  if (sdCardReady) {
    if (SD.exists(WIFI_CONFIG_FILE)) {
      SD.remove(WIFI_CONFIG_FILE);
      Serial.println("[FORGET WI-FI] Removed SD " + String(WIFI_CONFIG_FILE));
    }
    if (SD.exists(WIFI_CONFIG_LEGACY)) {
      SD.remove(WIFI_CONFIG_LEGACY);
      Serial.println("[FORGET WI-FI] Removed SD " + String(WIFI_CONFIG_LEGACY));
    }
  }

  // 3. Clear runtime credentials & shut down Wi-Fi radio completely
  currentSsid = "";
  currentPass = "";
  wifiConnected = false;
  internetAvailable = false;
  WiFi.disconnect(true, true);
  WiFi.mode(WIFI_OFF);
  delay(250);

  // 4. Turn ON Bluetooth BLE Provisioning Server so Web App can pair immediately
  startBleServer();
  sendBleStatus("{\"event\":\"FORGOTTEN\",\"mode\":\"BLE_SETUP\"}");
  lcdMsg("BLE SETUP MODE", "PAIR ON WEB/APP");
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
  Serial.println("[WIFI] Target SSID: '" + testSsid + "' (Max 3 Reconnect Attempts)");
  if (testPass.length() > 0) {
    Serial.println("[WIFI] Password:    [" + String(testPass.length()) +
                   " characters]");
  } else {
    Serial.println("[WIFI] Password:    (NONE / OPEN NETWORK)");
  }
  Serial.println("===========================================");

  lcdMsg("WIFI CONNECT 1/3", testSsid.substring(0, 16));

  // 1. CRITICAL: Stop Bluedroid BLE stack BEFORE starting Wi-Fi!
  // ESP32 cannot allocate the Wi-Fi FreeRTOS task ("wifi:create wifi task: failed to create task",
  // Status: 254) if the Bluedroid BLE stack (~105KB DRAM) is still holding internal RAM.
  bool cameFromBle = (bleStackInitialized || bleServerRunning);
  if (cameFromBle) {
    stopBleAndFreeRam();
  }

  // If heap is low after stopping BLE, temporarily free ramCards (~20KB) in-place first
  if (ESP.getMaxAllocHeap() < 55000 && ramCards != NULL) {
    free(ramCards);
    ramCards = NULL;
    ramCardCount = 0;
  }

  // Only reboot if we just came from BLE AND heap is still < 45KB even after freeing ramCards
  if (cameFromBle && ESP.getMaxAllocHeap() < 45000) {
    Serial.printf("[WIFI] Heap fragmented after BLE (MaxBlock=%u). Rebooting cleanly into Wi-Fi mode...\n",
                  ESP.getMaxAllocHeap());
    lcdMsg("APPLYING WIFI...", "REBOOTING GATE");
    saveWifiToSD(testSsid, testPass);
    saveWifiToNVS(testSsid, testPass);
    delay(400);
    ESP.restart();
  }

  // Proper Buck-Converter-Safe WiFi mode initialization
  delay(150);
  if (WiFi.getMode() != WIFI_STA) {
    WiFi.mode(WIFI_STA);
    WiFi.setTxPower(WIFI_POWER_11dBm); // Prevents 500mA RF spike on 12V battery buck converter
    delay(200);
    lcd.begin(16, 2); // Recover I2C LCD in case 5V rail had a microsecond ripple during RF init
  } else {
    WiFi.setTxPower(WIFI_POWER_11dBm);
  }
  WiFi.persistent(false);
  WiFi.setAutoReconnect(false);
  applyWifiPowerSave();

  const int MAX_ATTEMPTS = 3;
  int perAttemptTimeout = (timeoutSeconds >= 15) ? (timeoutSeconds / 3 + 2) : 7; // ~7 seconds per attempt

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

    delay(150);
    if (((int)WiFi.status() == 254 || WiFi.status() == WL_NO_SHIELD) && cameFromBle) {
      Serial.println("\n[WIFI] Driver task allocation error (Status 254) -> Rebooting cleanly with saved SD/NVS credentials!");
      saveWifiToSD(testSsid, testPass);
      saveWifiToNVS(testSsid, testPass);
      delay(300);
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
      int dhcpWait = 0;
      while (WiFi.localIP() == IPAddress(0, 0, 0, 0) && dhcpWait < 20) {
        delay(250);
        dhcpWait++;
      }

      wifiConnected = true;
      internetAvailable = true;
      inBleSetupMode = false;
      consecutiveNetFails = 0;
      lastWifiRetryMs = millis();
      WiFi.setTxPower(WIFI_POWER_15dBm);
      applyWifiPowerSave();
      if (WiFi.dnsIP() == IPAddress(0, 0, 0, 0)) {
        WiFi.setDNS(IPAddress(8, 8, 8, 8), IPAddress(1, 1, 1, 1));
      }
      configTime(0, 0, "pool.ntp.org", "time.google.com");

      Serial.println("\n[OK] WiFi Connected! IP: " + WiFi.localIP().toString() +
                     " | RSSI: " + String(WiFi.RSSI()) + " dBm | DNS: " + WiFi.dnsIP().toString());
      lcdMsg("WiFi CONNECTED", WiFi.localIP().toString());
      signalWifiConnectedSuccess(); // 3 Green blinks, then Red Standby
      delay(400);

      lcdMsg("SAVING WI-FI...", "SD & NVS BACKUP");
      saveWifiToSD(testSsid, testPass);
      saveWifiToNVS(testSsid, testPass);
      currentSsid = testSsid;
      currentPass = testPass;
      persistEpochIfValidUHF();
      if (ramCards == NULL) {
        loadWhitelistFromSD();
      }
      delay(400);

      Serial.println("[WIFI] Stable connection established.");
      sendDeviceHeartbeat();
      return true;
    }

    Serial.printf("\n[WIFI] Attempt %d/%d failed (Status: %d).\n", attempt, MAX_ATTEMPTS, WiFi.status());
    if (attempt < MAX_ATTEMPTS) {
      lcdMsg("RETRYING WIFI...", String(attempt + 1) + " of 3");
      delay(800);
    }
  }

  // ── ALL 3 ATTEMPTS EXHAUSTED: Shut down Wi-Fi, Enter Offline Mode, & Open Bluetooth for Provisioning ──
  wifiConnected = false;
  internetAvailable = false;
  inBleSetupMode = true;
  lastWifiRetryMs = millis();

  int st = WiFi.status();
  String errDetail = "3 Attempts Timed Out";
  if (st == WL_NO_SSID_AVAIL) {
    errDetail = "SSID not found on 2.4GHz";
  } else if (st == WL_CONNECT_FAILED) {
    errDetail = "Password rejected";
  }

  Serial.println("\n[WIFI] ❌ 3 connection attempts failed (" + errDetail +
                 "). Turning off Wi-Fi, operating in Offline Mode, & opening Bluetooth for provisioning.");
  WiFi.setAutoReconnect(false);
  WiFi.disconnect(true, false);
  WiFi.mode(WIFI_OFF);
  delay(250);

  // LCD status updates so user sees what happened without IDE
  lcdMsg("WIFI FAILED 3/3", "BLUETOOTH OPEN");
  delay(1500);

  // Open Bluetooth immediately so user can encode SSID & Password while gate operates in Offline SD Mode
  startBleServer();

  String failPayload = "{\"event\":\"FAILED\",\"error\":\"" + errDetail +
                       "\",\"code\":" + String(st) + "}";
  sendBleStatus(failPayload);

  return false;
}

// =====================================================
// 7. REAL CAMPUS PRESENCE STATE MACHINE
// =====================================================
bool isTagCurrentlyInsideOnline(String uid) {
  if (!wifiConnected || !internetAvailable)
    return false;

  WiFiClientSecure client;
  client.setInsecure();
  client.setHandshakeTimeout(3);

  String url =
      String(SUPABASE_URL) + "/rest/v1/transactions?rfid_uid=eq." +
      urlEncode(uid) +
      "&status=eq.AUTHORIZED&order=timestamp.desc&limit=1&select=direction";

  HTTPClient http;
  http.begin(client, url);
  http.setTimeout(2500);
  http.addHeader("apikey", SUPABASE_ANON);
  http.addHeader("Authorization", String("Bearer ") + SUPABASE_ANON);

  int code = http.GET();
  String body = "";
  if (code == 200) {
    body = http.getString();
    internetAvailable = true;
    consecutiveNetFails = 0;
  } else if (code < 0) {
    consecutiveNetFails++;
    if (consecutiveNetFails >= 2) internetAvailable = false;
  }
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
// OFFLINE WHITELIST VERIFICATION (Local MicroSD Cache)
// =====================================================
bool checkAuthorizationOffline(String targetUid) {
  card_found = false;
  card_authorized = false;
  card_matchedUid = targetUid;
  card_name = "";
  card_plate = "";
  card_role = "";
  card_cpassId = "";
  card_userType = "VEHICLE";
  card_vehicleId = "";
  card_userId = "";

  if (!sdCardReady || !SD.exists(WHITELIST_FILE)) {
    if (!wifiConnected || WiFi.status() != WL_CONNECTED) {
      card_name = "Offline User";
      card_plate = "OFFLINE";
      card_role = "Permitted";
      card_authorized = (targetUid.length() >= 4);
    }
    return card_authorized;
  }

  File f = SD.open(WHITELIST_FILE, FILE_READ);
  if (!f) {
    if (!wifiConnected || WiFi.status() != WL_CONNECTED) {
      card_name = "Offline User";
      card_plate = "OFFLINE";
      card_role = "Permitted";
      card_authorized = (targetUid.length() >= 4);
    }
    return card_authorized;
  }

  String cleanTarget = targetUid;
  cleanTarget.trim();
  while (cleanTarget.length() > 1 && cleanTarget.startsWith("0")) {
    cleanTarget = cleanTarget.substring(1);
  }

  int totalRows = 0;
  while (f.available()) {
    String line = f.readStringUntil('\n');
    line.trim();
    if (line.length() == 0 || line.startsWith("UID,")) continue;
    totalRows++;

    int p1 = line.indexOf(',');
    if (p1 <= 0) continue;
    String storedUid = line.substring(0, p1);
    storedUid.trim();

    String cleanStored = storedUid;
    while (cleanStored.length() > 1 && cleanStored.startsWith("0")) {
      cleanStored = cleanStored.substring(1);
    }

    if (storedUid.equalsIgnoreCase(targetUid) || cleanStored.equalsIgnoreCase(cleanTarget)) {
      card_found = true;
      card_matchedUid = storedUid;

      int p2 = line.indexOf(',', p1 + 1);
      card_name = (p2 > 0) ? line.substring(p1 + 1, p2) : "User";
      int p3 = (p2 > 0) ? line.indexOf(',', p2 + 1) : -1;
      card_plate = (p3 > 0) ? line.substring(p2 + 1, p3) : "NO-PLATE";
      int p4 = (p3 > 0) ? line.indexOf(',', p3 + 1) : -1;
      card_role = (p4 > 0) ? line.substring(p3 + 1, p4) : "Resident";
      int p5 = (p4 > 0) ? line.indexOf(',', p4 + 1) : -1;
      card_userType = (p5 > 0) ? line.substring(p4 + 1, p5) : "VEHICLE";
      int p6 = (p5 > 0) ? line.indexOf(',', p5 + 1) : -1;
      card_vehicleId = (p6 > 0) ? line.substring(p5 + 1, p6) : "";
      int p7 = (p6 > 0) ? line.indexOf(',', p6 + 1) : -1;
      card_userId = (p7 > 0) ? line.substring(p6 + 1, p7) : "";
      int p8 = (p7 > 0) ? line.indexOf(',', p7 + 1) : -1;
      card_authorized = (p8 > 0) ? (line.substring(p7 + 1, p8) == "true") : true;
      int p9 = (p8 > 0) ? line.indexOf(',', p8 + 1) : -1;
      card_cpassId = (p9 > 0) ? line.substring(p9 + 1) : "";

      break;
    }
  }
  f.close();

  // If whitelist on SD has 0 registered vehicles synced yet AND device is offline:
  if (!card_found && totalRows == 0 && targetUid.length() >= 4 &&
      (!wifiConnected || WiFi.status() != WL_CONNECTED)) {
    card_name = "Offline Vehicle";
    card_plate = "OFFLINE";
    card_role = "Authorized (Uncached)";
    card_authorized = true;
    Serial.printf("  ⚠️ [OFFLINE PERMISSIVE] Whitelist has 0 records. Allowing tag %s and buffering scan to SD.\n", targetUid.c_str());
  }

  return card_authorized;
}

// =====================================================
// 8. VERIFICATION & TRANSACTION POSTING
// =====================================================
bool checkAuthorizationOnline(String uid) {
  if (!wifiConnected || WiFi.status() != WL_CONNECTED)
    return false;

  card_found = false;
  card_authorized = false;
  card_matchedUid = uid;
  card_name = "";
  card_plate = "";
  card_role = "";
  card_cpassId = "";
  card_userType = "VEHICLE";
  card_rfidType = "LONG_RANGE";
  card_vehicleId = "";
  card_userId = "";

  // Ensure sufficient contiguous heap for mbedTLS handshake
  secureClient.stop();
  bool freedRamCards = false;
  if (sdCardReady && ramCards != NULL && ESP.getMaxAllocHeap() < 42000) {
    free(ramCards);
    ramCards = NULL;
    ramCardCount = 0;
    freedRamCards = true;
  }

  secureClient.setInsecure();
  secureClient.setHandshakeTimeout(4);

  String cleanUid = uid;
  cleanUid.trim();
  while (cleanUid.length() > 1 && cleanUid.startsWith("0")) {
    cleanUid = cleanUid.substring(1);
  }
  unsigned long numVal = (unsigned long)cleanUid.toInt();
  char pBuf8[16], pBuf10[16];
  snprintf(pBuf8, sizeof(pBuf8), "%08lu", numVal % 100000000UL);
  snprintf(pBuf10, sizeof(pBuf10), "%010lu", numVal);
  String padded8 = String(pBuf8);
  String padded10 = String(pBuf10);

  // Construct query that matches raw, clean, 8-digit, or 10-digit zero-padded format
  String filterParam;
  if (numVal > 0) {
    filterParam = "or=(rfid_uid.eq." + urlEncode(uid) +
                  ",rfid_uid.eq." + urlEncode(cleanUid) +
                  ",rfid_uid.eq." + urlEncode(padded8) +
                  ",rfid_uid.eq." + urlEncode(padded10) + ")";
  } else {
    filterParam = "rfid_uid=eq." + urlEncode(uid);
  }

  // 1. Check Special Tags (Visitor / Emergency)
  String specUrl = String(SUPABASE_URL) + "/rest/v1/special_tags?" + filterParam +
                   "&select=rfid_uid,type,label,description,rfid_type,user_type";
  HTTPClient httpSpec;
  httpSpec.useHTTP10(true);
  httpSpec.begin(secureClient, specUrl);
  httpSpec.setTimeout(3000);
  httpSpec.addHeader("apikey", SUPABASE_ANON);
  httpSpec.addHeader("Authorization", String("Bearer ") + SUPABASE_ANON);
  int specCode = httpSpec.GET();
  if (specCode == 200) {
    String specBody = httpSpec.getString();
    httpSpec.end();
    secureClient.stop();
    DynamicJsonDocument specDoc(512);
    if (deserializeJson(specDoc, specBody) == DeserializationError::Ok) {
      JsonArray specArr = specDoc.as<JsonArray>();
      if (specArr.size() > 0) {
        card_found = true;
        card_authorized = true;
        card_matchedUid = String(specArr[0]["rfid_uid"] | uid);
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
        internetAvailable = true;
        consecutiveNetFails = 0;
        if (freedRamCards) loadWhitelistFromSD();
        return true;
      }
    }
  } else {
    httpSpec.end();
    secureClient.stop();
  }

  // 2. Query Registered Users & Vehicles (including user's vehicles relation as fallback)
  String url =
      String(SUPABASE_URL) + "/rest/v1/rfid_cards?" + filterParam +
      "&select=rfid_uid,authorization_status,vehicle_id,user_id,rfid_type,user_type,"
      "vehicles(id,plate_number,vehicle_type,vehicle_model),"
      "users(full_name,role,role_detail,default_transit_mode,cpass_id,student_id,"
      "vehicles(id,plate_number,vehicle_type,vehicle_model))";

  HTTPClient http;
  http.useHTTP10(true);
  http.begin(secureClient, url);
  http.setTimeout(3500);
  http.addHeader("apikey", SUPABASE_ANON);
  http.addHeader("Authorization", String("Bearer ") + SUPABASE_ANON);

  int code = http.GET();
  String body = "";
  if (code == 200) {
    body = http.getString();
    http.end();
    secureClient.stop();
    internetAvailable = true;
    consecutiveNetFails = 0;
  } else {
    http.end();
    secureClient.stop();
    if (freedRamCards) loadWhitelistFromSD();
    return false;
  }

  DynamicJsonDocument doc(2048);
  if (deserializeJson(doc, body) != DeserializationError::Ok) {
    if (freedRamCards) loadWhitelistFromSD();
    return false;
  }

  JsonArray arr = doc.as<JsonArray>();
  if (arr.size() == 0) {
    if (freedRamCards) loadWhitelistFromSD();
    return false;
  }

  JsonObject card = arr[0];
  card_found = true;
  card_matchedUid = String(card["rfid_uid"] | uid);
  card_authorized =
      (String(card["authorization_status"].as<const char *>()) == "AUTHORIZED");
  card_vehicleId = String(card["vehicle_id"] | "");
  if (card_vehicleId == "null") card_vehicleId = "";
  card_userId = String(card["user_id"] | "");
  if (card_userId == "null") card_userId = "";
  card_userType = "VEHICLE";
  card_rfidType = "LONG_RANGE";

  if (!card["vehicles"].isNull()) {
    card_plate = String(card["vehicles"]["plate_number"] | "");
    if (card_vehicleId.length() == 0) {
      card_vehicleId = String(card["vehicles"]["id"] | "");
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

    // Fallback to user's vehicles array if rfid_cards.vehicle_id was not directly linked
    if ((card_plate.length() == 0 || card_plate == "null" || card_plate == "PEDESTRIAN") &&
        !card["users"]["vehicles"].isNull() && card["users"]["vehicles"].is<JsonArray>()) {
      JsonArray uVehs = card["users"]["vehicles"].as<JsonArray>();
      if (uVehs.size() > 0) {
        String uPlate = String(uVehs[0]["plate_number"] | "");
        if (uPlate.length() > 0 && uPlate != "null") {
          card_plate = uPlate;
        }
        if (card_vehicleId.length() == 0) {
          card_vehicleId = String(uVehs[0]["id"] | "");
        }
      }
    }
  }

  if (card_plate.length() == 0 || card_plate == "null") {
    card_plate = "REGISTERED";
  }

  if (freedRamCards) loadWhitelistFromSD();
  return card_authorized;
}

void syncWhitelistToRam() {
  if (!wifiConnected || WiFi.status() != WL_CONNECTED)
    return;
  Serial.println("\n[RAM CACHE] Syncing registered cards from Supabase (Paginated)...");
  lcdMsg("SYNCING DATABASE", "CONNECTING...");

  // Verify DNS resolution for Supabase before making HTTPS requests
  IPAddress hostIp;
  if (!WiFi.hostByName("xrdpgsnastqnbhvdltwt.supabase.co", hostIp)) {
    Serial.println("[DNS] Resolving Supabase via router DNS failed, trying 8.8.8.8 fallback...");
    WiFi.setDNS(IPAddress(8, 8, 8, 8), IPAddress(1, 1, 1, 1));
    if (!WiFi.hostByName("xrdpgsnastqnbhvdltwt.supabase.co", hostIp)) {
      Serial.println("[DNS ERROR] Cannot resolve Supabase hostname! Check router or internet connection.");
      lcdMsg("DB SYNC FAILED", "DNS ERROR");
      delay(1200);
      return;
    } else {
      Serial.printf("[DNS OK] Supabase resolved via fallback DNS: %s\n", hostIp.toString().c_str());
    }
  } else {
    Serial.printf("[DNS OK] Supabase resolved to: %s\n", hostIp.toString().c_str());
  }

  const char *UHF_TMP_FILE = "/uhf_whitelist.tmp";
  bool useSdTmp = sdCardReady;
  if (useSdTmp && SD.exists(UHF_TMP_FILE)) {
    SD.remove(UHF_TMP_FILE);
  }

  // Temporarily release ramCards buffer while TLS downloads pages to SD
  // so mbedTLS and HTTPClient have ~75KB of free heap!
  secureClient.stop();
  if (useSdTmp && ramCards != NULL) {
    free(ramCards);
    ramCards = NULL;
  }
  ramCardCount = 0;

  bool syncSuccess = true;
  const int BATCH_SIZE = 5; // Small 5-card pages (~1.1KB) fit in a single TCP segment & TLS record
  int offset = 0;
  int totalCardsFetched = 0;

  // 1. Paginated fetch of ALL authorized RFID cards (includes cards where user_type was not explicitly set)
  while (true) {
    if (offset == 0) {
      lcdMsg("SYNCING DATABASE", "FETCHING CARDS..");
    } else {
      lcdMsg("SYNCING DATABASE", "FETCHED: " + String(totalCardsFetched));
    }

    String url = String(SUPABASE_URL) +
      "/rest/v1/rfid_cards?authorization_status=eq.AUTHORIZED"
      "&select=rfid_uid,authorization_status,vehicle_id,user_id,rfid_type,user_type,"
      "vehicles(id,plate_number,vehicle_type,vehicle_model),"
      "users(full_name,role,role_detail,cpass_id,student_id,vehicles(id,plate_number,vehicle_type))"
      "&order=rfid_uid.asc&limit=" + String(BATCH_SIZE) + "&offset=" + String(offset);

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
        secureClient.stop(); // Free ~36KB mbedTLS buffers before JSON parse!
        body.trim();
        if (body.startsWith("[") && body.endsWith("]")) {
          break;
        }
        Serial.printf("[UHF SYNC] Incomplete payload (%d bytes) at offset %d, retrying (%d/%d)...\n",
                      body.length(), offset, retry, MAX_PAGE_RETRIES);
        code = -1;
      } else {
        char sslErr[128] = {0};
        int sslCode = secureClient.lastError(sslErr, sizeof(sslErr));
        String errStr = http.errorToString(code);
        http.end();
        secureClient.stop();
        Serial.printf("[UHF SYNC] Page fetch attempt %d/%d failed at offset %d (HTTP %d: %s | SSL %d: %s | FreeHeap: %d / MaxBlock: %d)\n",
                      retry, MAX_PAGE_RETRIES, offset, code, errStr.c_str(), sslCode, sslErr, ESP.getFreeHeap(), ESP.getMaxAllocHeap());
      }
      if (retry < MAX_PAGE_RETRIES) {
        lcdMsg("DB RETRY " + String(retry + 1) + "/3", "WAITING RETRY");
        delay(600);
      }
    }

    if (code != 200) {
      Serial.printf("[UHF SYNC] All %d attempts failed at offset %d (HTTP %d)\n",
                    MAX_PAGE_RETRIES, offset, code);
      syncSuccess = false;
      lcdMsg("DB SYNC FAILED", "HTTP CODE: " + String(code));
      delay(1200);
      break;
    }

    DynamicJsonDocument doc(4096);
    DeserializationError jsonErr = deserializeJson(doc, body);
    body = "";
    if (jsonErr) {
      Serial.printf("[UHF SYNC ERROR] JSON parse failed at offset %d: %s (Heap: %d / MaxBlock: %d)\n",
                    offset, jsonErr.c_str(), ESP.getFreeHeap(), ESP.getMaxAllocHeap());
      syncSuccess = false;
      lcdMsg("DB SYNC FAILED", "JSON PARSE FAIL");
      delay(1200);
      break;
    }

    JsonArray arr = doc.as<JsonArray>();
    int countInBatch = arr.size();
    if (countInBatch == 0) {
      break; // No more cards
    }

    File tmpFile;
    if (useSdTmp) {
      tmpFile = SD.open(UHF_TMP_FILE, offset == 0 ? FILE_WRITE : FILE_APPEND);
      if (tmpFile && offset == 0) {
        tmpFile.println("UID,NAME,PLATE,ROLE,USER_TYPE,VEHICLE_ID,USER_ID,AUTHORIZED,IS_INSIDE,CPASS_ID");
      }
    }

    for (JsonObject item : arr) {
      String uid = String(item["rfid_uid"] | "");
      uid.trim();
      if (uid.length() == 0 || uid.startsWith("UNASSIGNED_")) continue;

      String status = String(item["authorization_status"] | "PENDING");
      bool auth = (status == "AUTHORIZED");
      String vId = String(item["vehicle_id"] | "");
      if (vId == "null") vId = "";
      String uId = String(item["user_id"] | "");
      if (uId == "null") uId = "";
      String uType = "VEHICLE";
      String plate = "NO-PLATE";
      String name = "Cardholder";
      String role = "User";
      String cpass = "";

      if (!item["vehicles"].isNull()) {
        plate = String(item["vehicles"]["plate_number"] | "NO-PLATE");
        if (vId.length() == 0) {
          vId = String(item["vehicles"]["id"] | "");
        }
      }
      if (!item["users"].isNull()) {
        name = String(item["users"]["full_name"] | "Registered User");
        role = String(item["users"]["role"] | "Resident");
        String roleDetail = String(item["users"]["role_detail"] | "");
        if (role == "OTHERS" && roleDetail.length() > 0) {
          role = roleDetail;
        }
        cpass = String(item["users"]["cpass_id"] | "");
        if (cpass.length() == 0 || cpass == "null") {
          cpass = String(item["users"]["student_id"] | "");
        }
        if (cpass == "null") cpass = "";

        if ((plate == "NO-PLATE" || plate == "null" || plate == "PEDESTRIAN") &&
            !item["users"]["vehicles"].isNull() && item["users"]["vehicles"].is<JsonArray>()) {
          JsonArray uVehs = item["users"]["vehicles"].as<JsonArray>();
          if (uVehs.size() > 0) {
            String uPlate = String(uVehs[0]["plate_number"] | "");
            if (uPlate.length() > 0 && uPlate != "null") plate = uPlate;
            if (vId.length() == 0) vId = String(uVehs[0]["id"] | "");
          }
        }
      }
      name.replace(",", " ");
      plate.replace(",", " ");

      // Add to RAM (if not using SD temp buffer)
      addCardToRam(uid, name, plate, role, uType, vId, uId, auth, false, cpass);

      // Write to SD temp
      if (useSdTmp && tmpFile) {
        tmpFile.printf("%s,%s,%s,%s,%s,%s,%s,%s,%s,%s\n",
                       uid.c_str(), name.c_str(), plate.c_str(), role.c_str(),
                       uType.c_str(), vId.c_str(), uId.c_str(),
                       auth ? "true" : "false", "false", cpass.c_str());
      }
      totalCardsFetched++;
    }
    if (tmpFile) tmpFile.close();

    offset += countInBatch;
    if (countInBatch < BATCH_SIZE) {
      break; // Last page reached
    }
    delay(50);
  }

  // 2. Fetch special tags (Visitors / Emergency)
  if (syncSuccess) {
    String specUrl = String(SUPABASE_URL) +
                     "/rest/v1/special_tags?select=rfid_uid,type,label,rfid_type,user_type";
    int sCode = -1;
    String specBody = "";
    {
      secureClient.stop();
      secureClient.setInsecure();
      secureClient.setHandshakeTimeout(6);

      HTTPClient httpSpec;
      httpSpec.useHTTP10(true);
      httpSpec.begin(secureClient, specUrl);
      httpSpec.setTimeout(4000);
      httpSpec.addHeader("apikey", SUPABASE_ANON);
      httpSpec.addHeader("Authorization", String("Bearer ") + SUPABASE_ANON);
      sCode = httpSpec.GET();
      if (sCode == 200) {
        specBody = httpSpec.getString();
      }
      httpSpec.end();
      secureClient.stop();
    }
    if (sCode == 200 && specBody.length() > 0) {
      DynamicJsonDocument sDoc(3072);
      if (deserializeJson(sDoc, specBody) == DeserializationError::Ok) {
        JsonArray arr = sDoc.as<JsonArray>();
        File tmpFile;
        if (useSdTmp) {
          tmpFile = SD.open(UHF_TMP_FILE, totalCardsFetched == 0 ? FILE_WRITE : FILE_APPEND);
          if (tmpFile && totalCardsFetched == 0) {
            tmpFile.println("UID,NAME,PLATE,ROLE,USER_TYPE,VEHICLE_ID,USER_ID,AUTHORIZED,IS_INSIDE,CPASS_ID");
          }
        }
        for (JsonObject item : arr) {
          String uid = String(item["rfid_uid"] | "");
          uid.trim();
          if (uid.length() == 0) continue;
          String sType = String(item["type"] | "VISITOR");
          String lbl = String(item["label"] | (sType == "EMERGENCY" ? "Emergency Responder" : "Visitor Pass"));
          String uType = String(item["user_type"] | "VEHICLE");
          String plate = (sType == "EMERGENCY" ? "EMERGENCY" : "VISITOR PASS");
          lbl.replace(",", " ");
          plate.replace(",", " ");

          addCardToRam(uid, lbl, plate, sType, uType, "", "", true, false, "");

          if (useSdTmp && tmpFile) {
            tmpFile.printf("%s,%s,%s,%s,%s,%s,%s,%s,%s,%s\n",
                           uid.c_str(), lbl.c_str(), plate.c_str(), sType.c_str(),
                           uType.c_str(), "", "", "true", "false", "");
          }
          totalCardsFetched++;
        }
        if (tmpFile) tmpFile.close();
      }
    }
  }

  // 3. Finalize SD atomic write & reload into high-speed RAM cache (re-allocates ramCards after all TLS is closed)
  if (useSdTmp) {
    if (syncSuccess && totalCardsFetched > 0) {
      if (SD.exists(WHITELIST_FILE)) {
        SD.remove(WHITELIST_FILE);
      }
      SD.rename(UHF_TMP_FILE, WHITELIST_FILE);
      loadWhitelistFromSD();
      Serial.printf("[SD WHITELIST] Atomic save complete! %d cards saved to %s (%d loaded into fast RAM)\n",
                    totalCardsFetched, WHITELIST_FILE, ramCardCount);
      internetAvailable = true;
      consecutiveNetFails = 0;
      lcdMsg("DB SYNC COMPLETE", String(totalCardsFetched) + " CARDS SYNCED");
      delay(600);
    } else {
      if (SD.exists(UHF_TMP_FILE)) SD.remove(UHF_TMP_FILE);
      Serial.println("[SD WHITELIST] Sync had errors or was empty; preserved existing SD whitelist.");
      loadWhitelistFromSD();
    }
  }

  Serial.printf("[RAM CACHE] Successfully loaded %d registered card(s) into high-speed memory!\n",
                ramCardCount);
}

void processCloudQueue() {
  if (txQueueCount == 0 || !wifiConnected || WiFi.status() != WL_CONNECTED)
    return;
  // If Wiegand is currently receiving pulses, NEVER interrupt the reader!
  if (wiegandBitCount > 0)
    return;

  static unsigned long lastQueueAttempt = 0;
  if (millis() - lastQueueAttempt < 80)
    return;
  lastQueueAttempt = millis();

  QueuedTransaction item = txQueue[txQueueHead];
  txQueueHead = (txQueueHead + 1) % MAX_TX_QUEUE;
  txQueueCount--;

  insertTransactionOnline(item.uid, item.direction, item.status, item.remarks,
                          item.vehicleId, item.userId, item.userType);
}

void insertTransactionOnline(String uid, String direction, String status,
                             String remarks, String vId, String uId,
                             String uType) {
  String targetVId = (vId.length() > 0 ? vId : card_vehicleId);
  String targetUId = (uId.length() > 0 ? uId : card_userId);

  if (!wifiConnected || WiFi.status() != WL_CONNECTED) {
    saveOfflineTransactionSD(uid, direction, status, remarks, targetVId, targetUId, uType);
    return;
  }

  // Ensure mbedTLS has plenty of contiguous heap (>50KB) to POST transaction reliably
  secureClient.stop();
  bool freedRamCards = false;
  if (sdCardReady && ramCards != NULL && ESP.getMaxAllocHeap() < 42000) {
    free(ramCards);
    ramCards = NULL;
    ramCardCount = 0;
    freedRamCards = true;
  }

  String url = String(SUPABASE_URL) + "/rest/v1/transactions";

  secureClient.setInsecure();
  secureClient.setHandshakeTimeout(5);

  HTTPClient http;
  http.useHTTP10(true);
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
  doc["user_type"] = "VEHICLE";
  doc["rfid_type"] = "LONG_RANGE";

  if (targetVId.length() > 0 && targetVId != "null")
    doc["vehicle_id"] = targetVId;
  if (targetUId.length() > 0 && targetUId != "null")
    doc["user_id"] = targetUId;

  String body;
  serializeJson(doc, body);
  int httpCode = http.POST(body);
  http.end();
  secureClient.stop();

  // If Supabase rejected vehicle_id/user_id FK constraint (e.g. HTTP 400/409), retry without optional FKs so scan is ALWAYS recorded!
  if (httpCode == 400 || httpCode == 409 || httpCode == 422) {
    DynamicJsonDocument fallbackDoc(384);
    fallbackDoc["rfid_uid"] = uid;
    fallbackDoc["direction"] = direction;
    fallbackDoc["gate"] = GATE_ID;
    fallbackDoc["status"] = status;
    fallbackDoc["remarks"] = remarks;
    fallbackDoc["user_type"] = "VEHICLE";
    fallbackDoc["rfid_type"] = "LONG_RANGE";
    String fallbackBody;
    serializeJson(fallbackDoc, fallbackBody);

    HTTPClient http2;
    http2.useHTTP10(true);
    http2.begin(secureClient, url);
    http2.setTimeout(4000);
    http2.addHeader("Content-Type", "application/json");
    http2.addHeader("apikey", SUPABASE_ANON);
    http2.addHeader("Authorization", String("Bearer ") + SUPABASE_ANON);
    http2.addHeader("Prefer", "return=minimal");
    httpCode = http2.POST(fallbackBody);
    http2.end();
    secureClient.stop();
  }

  if (freedRamCards) {
    loadWhitelistFromSD();
  }

  Serial.printf("[CLOUD TX] Transaction POST for UID '%s' (%s) -> HTTP %d\n", uid.c_str(), direction.c_str(), httpCode);
  if (httpCode >= 200 && httpCode < 300) {
    Serial.println("  [OK] Successfully pushed UHF scan transaction to Supabase Cloud!");
    internetAvailable = true;
    consecutiveNetFails = 0;
  } else {
    Serial.printf("  [WARN] Supabase POST failed with code %d. Saving to SD offline buffer.\n", httpCode);
    saveOfflineTransactionSD(uid, direction, status, remarks, targetVId, targetUId, "VEHICLE");
  }
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
    Serial.println("[OFFLINE BUFFER ERROR] SD card not ready - scan could not be stored!");
    return;
  }
  File f = SD.open(OFFLINE_TX_FILE, FILE_APPEND);
  if (!f) {
    Serial.println("[OFFLINE BUFFER ERROR] Failed to open " + String(OFFLINE_TX_FILE) + " for append!");
    return;
  }
  String ts = isoUtcNow();
  f.println((ts.length() > 0 ? ts : "") + "|" + cleanField(uid) + "|" + dir + "|" + status +
            "|" + cleanField(remarks) + "|" + cleanField(vId) + "|" +
            cleanField(uId) + "|" + cleanField(uType));
  f.flush();
  f.close();
  Serial.println("[OFFLINE BUFFER] Stored offline scan for " + uid + " (" + dir + ")");
}

// Same as insertTransactionOnline but returns success and can carry original tap time
bool insertTransactionOnlineTs(String uid, String direction, String status,
                               String remarks, String vId, String uId,
                               String uType, String ts) {
  if (!wifiConnected || WiFi.status() != WL_CONNECTED)
    return false;

  secureClient.stop();
  secureClient.setInsecure();
  secureClient.setHandshakeTimeout(5);

  HTTPClient http;
  http.useHTTP10(true);
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
  doc["user_type"] = "VEHICLE";
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
  secureClient.stop();

  if (code >= 200 && code < 300) {
    consecutiveNetFails = 0;
    internetAvailable = true;
    return true;
  }
  return false;
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
  if (!wifiConnected || WiFi.status() != WL_CONNECTED || !sdCardReady || !SD.exists(OFFLINE_TX_FILE))
    return;
  if (txQueueCount > 0 || wiegandBitCount > 0)
    return;
  if (millis() - lastFlush < 4000)
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

  const int MAX_BATCH_LINES = 30;
  String lines[MAX_BATCH_LINES];
  int totalLines = 0;
  String overflowContent = "";

  while (in.available()) {
    String line = in.readStringUntil('\n');
    line.trim();
    if (line.length() == 0)
      continue;
    if (totalLines < MAX_BATCH_LINES) {
      lines[totalLines++] = line;
    } else {
      overflowContent += line + "\n";
    }
  }
  in.close(); // Close SD file before TLS handshake to free FAT buffer!

  if (totalLines == 0) {
    SD.remove(OFFLINE_TX_FILE);
    return;
  }

  // Free ramCards temporarily so TLS handshakes have >55KB free heap
  secureClient.stop();
  bool freedRamCards = false;
  if (ramCards != NULL) {
    free(ramCards);
    ramCards = NULL;
    ramCardCount = 0;
    freedRamCards = true;
  }

  int sent = 0, kept = 0;
  bool halt = false;
  String remainingContent = "";

  for (int i = 0; i < totalLines; i++) {
    String &line = lines[i];
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
        lines[i] = "";
        delay(60);
        continue;
      }
      halt = true;
      lastFlush = millis() + 15000;
    }
    remainingContent += line + "\n";
    kept++;
    lines[i] = "";
  }

  if (overflowContent.length() > 0) {
    remainingContent += overflowContent;
  }

  SD.remove(OFFLINE_TX_FILE);
  if (remainingContent.length() > 0) {
    File out = SD.open(OFFLINE_TX_FILE, FILE_WRITE);
    if (out) {
      out.print(remainingContent);
      out.flush();
      out.close();
    }
  }

  if (freedRamCards) {
    loadWhitelistFromSD();
  }

  if (sent > 0)
    Serial.println("[OFFLINE BUFFER] Uploaded " + String(sent) +
                   " buffered scan(s), " + String(kept) + " remaining.");
}

// Called when Wi-Fi drops or internet is lost: move anything still waiting in RAM onto the SD card.
void spillRamQueueToSd() {
  int spilled = 0;
  while (txQueueCount > 0) {
    QueuedTransaction item = txQueue[txQueueHead];
    txQueueHead = (txQueueHead + 1) % MAX_TX_QUEUE;
    txQueueCount--;
    saveOfflineTransactionSD(item.uid, item.direction, item.status,
                             item.remarks, item.vehicleId, item.userId,
                             item.userType);
    spilled++;
  }
  if (spilled > 0) {
    Serial.printf("[OFFLINE BUFFER] Spilled %d RAM queue transactions directly to SD card.\n", spilled);
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

  // Multi-Tag Anti-Spam Check: Ignore duplicate pulses for this tag within 5s window
  if (isTagInCooldown(uid) ||
      (altUid.length() > 0 && isTagInCooldown(altUid))) {
    return;
  }

  // Optional: only act once the tag has been read enough times in a short window
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
    uType = "VEHICLE";
    vId = ramCards[cardIdx].vehicleId;
    uId = ramCards[cardIdx].userId;
    isInside = ramCards[cardIdx].isInside;

    if (authorized) {
      // 5-second Transit Anti-Passback Debounce:
      // While vehicle is passing through beam, ignore repeat pulses that would
      // log duplicate entry scans
      if (ramCards[cardIdx].lastActionTime > 0 &&
          (millis() - ramCards[cardIdx].lastActionTime < 5000)) {
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
    // RAM CACHE MISS: Query SD card cache FIRST (< 5ms) to eliminate network lag
    checkAuthorizationOffline(uid);
    if (!card_found && altUid.length() > 0) {
      checkAuthorizationOffline(altUid);
    }

    if (card_found) {
      authorized = card_authorized;
      finalUid = card_matchedUid;
      name = card_name;
      plate = card_plate;
      role = card_role;
      cpass = card_cpassId;
      uType = "VEHICLE";
      vId = card_vehicleId;
      uId = card_userId;
      direction = "ENTRY";
      if (authorized) isInside = true;

      // Promote to RAM immediately so next read is 0.05ms
      addCardToRam(finalUid, name, plate, role, uType, vId, uId, authorized, isInside, cpass);
      int newIdx = findCardInRam(finalUid);
      if (newIdx != -1) ramCards[newIdx].lastActionTime = millis();
      Serial.printf("  ⚡ [SD CACHE HIT] Tag %s promoted to RAM (%s - %s)\n", finalUid.c_str(), plate.c_str(), name.c_str());
    } else if (wifiConnected && WiFi.status() == WL_CONNECTED) {
      // Not in RAM, Not on SD: Query Supabase online!
      authorized = checkAuthorizationOnline(uid);
      if (!card_found && altUid.length() > 0) {
        authorized = checkAuthorizationOnline(altUid);
      }
      if (card_found && card_matchedUid.length() > 0) {
        finalUid = card_matchedUid;
      }

      direction = "ENTRY";
      if (authorized) {
        isInside = true;
      }

      name = card_name;
      plate = card_plate;
      role = card_role;
      cpass = card_cpassId;
      uType = "VEHICLE";
      vId = card_vehicleId;
      uId = card_userId;

      // Cache in RAM and append to SD so future scans are instant!
      if (authorized) {
        addCardToRam(finalUid, name, plate, role, uType, vId, uId, authorized, isInside, cpass);
        int newIdx = findCardInRam(finalUid);
        if (newIdx != -1) ramCards[newIdx].lastActionTime = millis();

        if (sdCardReady) {
          File f = SD.open(WHITELIST_FILE, FILE_APPEND);
          if (f) {
            f.printf("%s,%s,%s,%s,%s,%s,%s,%s,%s,%s\n",
                     finalUid.c_str(), name.c_str(), plate.c_str(), role.c_str(),
                     uType.c_str(), vId.c_str(), uId.c_str(),
                     "true", isInside ? "true" : "false", cpass.c_str());
            f.flush();
            f.close();
          }
        }
      }
    } else {
      // Offline fallback: check offline permissive rules
      authorized = checkAuthorizationOffline(finalUid);
      name = card_name;
      plate = card_plate;
      role = card_role;
      cpass = card_cpassId;
      uType = "VEHICLE";
      vId = card_vehicleId;
      uId = card_userId;
      direction = "ENTRY";
      if (authorized) isInside = true;
    }
  }

  // Mark this tag in the cooldown history table
  markTagInCooldown(uid, plate);
  if (altUid.length() > 0)
    markTagInCooldown(altUid, plate);
  if (finalUid != uid && finalUid != altUid)
    markTagInCooldown(finalUid, plate);

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
  Serial.printf("  Card ID (Dec): %s%s\n", finalUid.c_str(),
                altUid.length() > 0 ? (" | Alt: " + altUid).c_str() : "");
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
    digitalWrite(GREEN_LED, HIGH);
    digitalWrite(RED_LED, LOW);
    digitalWrite(YELLOW_LED, LOW);
    digitalWrite(RELAY_PIN, LOW); // Quick signal pulse
    beep(40, 1);
    digitalWrite(RELAY_PIN, HIGH);
  } else {
    digitalWrite(RED_LED, HIGH);
    digitalWrite(YELLOW_LED, LOW);
    digitalWrite(GREEN_LED, LOW);
    beep(120, 1);
  }

  // 5. AUTOMATICALLY SEND TO DATABASE (< 1 us queue, immediate POST in loop) - or buffer to SD when offline
  {
    String remarks = authorized
        ? ("UHF Vehicle Entry: " + (plate.length() > 0 ? plate : String("VEHICLE")) +
           (name.length() > 0 ? (" | Driver: " + name) : String("")))
        : ("Unregistered UHF Vehicle Tag (" + finalUid + ")");
    String st = authorized ? "AUTHORIZED" : "DENIED";
    if (wifiConnected && WiFi.status() == WL_CONNECTED) {
      enqueueTransaction(finalUid, direction, st, remarks, vId, uId, "VEHICLE");
      processCloudQueue(); // Immediately push to Supabase database so Guard sees vehicle right away!
    } else {
      saveOfflineTransactionSD(finalUid, direction, st, remarks, vId, uId,
                               "VEHICLE");
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

  // ---- 1. Immediate Pulse Diagnostics (Visible on EVERY pulse burst) ----
  Serial.println("\n========================================");
  Serial.printf("[WIEGAND PULSE DETECTED] Total bits: %d | Raw Hex: 0x%llX\n",
                bits, (unsigned long long)raw);
  Serial.printf(
      "  Pulse Breakdown: D0 (Purple) = %u pulses | D1 (Gray) = %u pulses\n",
      d0Pulses, d1Pulses);

  // Raw bit stream visualization (MSB first)
  Serial.print("  Raw Bitstream: ");
  int displayBits = bits > 64 ? 64 : bits;
  for (int i = displayBits - 1; i >= 0; i--) {
    Serial.print((raw & (1ULL << i)) ? '1' : '0');
    if (i % 8 == 0 && i > 0) Serial.print(' ');
  }
  if (bits > 64) Serial.printf(" (+%d overflow pulses)", bits - 64);
  Serial.println();

  if (d1Pulses == 0 && d0Pulses > 0) {
    Serial.println("  ⚠️ [LINE ALERT] ZERO pulses on D1! The Gray wire is "
                   "either loose or not connected to GPIO 33!");
  } else if (d0Pulses == 0 && d1Pulses > 0) {
    Serial.println("  ⚠️ [LINE ALERT] ZERO pulses on D0! The Purple wire is "
                   "either loose or not connected to GPIO 32!");
  }

  // ---- Filter 1: Discard frames with too few bits or all zeros ----
  if (bits < 4 || raw == 0) {
    Serial.printf("  [FILTER] Ignored all-zero/short pulse (%d bits)\n", bits);
    Serial.println("========================================");
    return false;
  }

  // ---- Filter 2: Discard all-ones noise (e.g. 0xFFFFFFFF / 4294967295) ----
  if ((raw & 0xFFFFFFFF) == 0xFFFFFFFF || (bits <= 64 && raw == ((1ULL << (bits > 63 ? 63 : bits)) - 1ULL))) {
    Serial.printf("  [FILTER] Ignored all-ones false trigger (%d bits, 0x%llX)\n",
                  bits, (unsigned long long)raw);
    Serial.println("========================================");
    return false;
  }

  // ---- Filter 3: Discard alternating 01010101 (0x55) or 10101010 (0xAA) crosstalk noise ----
  uint32_t low32 = (uint32_t)(raw & 0xFFFFFFFF);
  if (low32 == 0x55555555 || low32 == 0xAAAAAAAA ||
      (low32 & 0xFFFF) == 0x5555 || (low32 & 0xFFFF) == 0xAAAA ||
      low32 == 0x5555552A || low32 == 0x55AAAAAA) {
    Serial.printf("  [FILTER] Ignored alternating crosstalk frame (0x%llX, %d bits)\n",
                  (unsigned long long)raw, bits);
    Serial.println("========================================");
    return false;
  }

  // ---- Filter 4: Discard non-standard frame lengths ----
  // Valid RFID access control Wiegand standards are 24 to 40 bits (WG26, WG32, WG34, WG35, WG36, WG37)
  if (bits < 24 || bits > 40) {
    Serial.printf("  [FILTER] Discarded non-standard frame length: %d bits (Raw: 0x%llX). Standard RFID is 24-40 bits.\n",
                  bits, (unsigned long long)raw);
    Serial.println("========================================");
    return false;
  }

  // ---- Filter 5: Frame Confirmation (Active only if WIEGAND_CONFIRM_READS > 1) ----
#if WIEGAND_CONFIRM_READS > 1
  static uint64_t lastRawConfirmed = 0;
  static unsigned long lastRawConfirmedMs = 0;
  static int rawConsecutiveMatches = 0;

  unsigned long nowMs = millis();
  if (raw == lastRawConfirmed && (nowMs - lastRawConfirmedMs <= WIEGAND_CONFIRM_WINDOW_MS)) {
    rawConsecutiveMatches++;
  } else {
    lastRawConfirmed = raw;
    lastRawConfirmedMs = nowMs;
    rawConsecutiveMatches = 1;
  }

  if (rawConsecutiveMatches < WIEGAND_CONFIRM_READS) {
    Serial.printf("  [WIEGAND CONFIRM] Frame 0x%llX (%d bits) seen %d/%d (Awaiting confirmation...)\n",
                  (unsigned long long)raw, bits, rawConsecutiveMatches, WIEGAND_CONFIRM_READS);
    Serial.println("========================================");
    return false;
  }
  rawConsecutiveMatches = 0; // Confirmed! Reset for next vehicle tag
#endif

  uint32_t cardNumber = 0;
  uint32_t facilityCode = 0;
  char hexFormatted[32];
  char decPadded[16];
  hexFormatted[0] = '\0';
  decPadded[0] = '\0';

  if (bits == 26) {
    // WG26 format: 1 even parity + 8 facility + 16 card number + 1 odd parity
    int evenCount = 0;
    for (int i = 13; i <= 24; i++) {
      if ((raw >> i) & 1) evenCount++;
    }
    int oddCount = 0;
    for (int i = 1; i <= 12; i++) {
      if ((raw >> i) & 1) oddCount++;
    }
    bool pEvenOk = (((raw >> 25) & 1) == (evenCount % 2));
    bool pOddOk = (((raw >> 0) & 1) != (oddCount % 2));
    Serial.printf("  Parity:        Even=%s | Odd=%s\n",
                  pEvenOk ? "PASS" : "FAIL", pOddOk ? "PASS" : "FAIL");

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
    int evenCount = 0;
    for (int i = 17; i <= 32; i++) {
      if ((raw >> i) & 1) evenCount++;
    }
    int oddCount = 0;
    for (int i = 1; i <= 16; i++) {
      if ((raw >> i) & 1) oddCount++;
    }
    bool pEvenOk = (((raw >> 33) & 1) == (evenCount % 2));
    bool pOddOk = (((raw >> 0) & 1) != (oddCount % 2));
    Serial.printf("  Parity:        Even=%s | Odd=%s\n",
                  pEvenOk ? "PASS" : "FAIL", pOddOk ? "PASS" : "FAIL");

    cardNumber = (raw >> 1) & 0xFFFFFFFF;
    snprintf(hexFormatted, sizeof(hexFormatted), "%02X %02X %02X %02X",
             (uint8_t)(cardNumber >> 24), (uint8_t)(cardNumber >> 16),
             (uint8_t)(cardNumber >> 8), (uint8_t)(cardNumber & 0xFF));
    char dec8[16];
    snprintf(dec8, sizeof(dec8), "%08lu", (unsigned long)(cardNumber % 100000000UL));
    snprintf(decPadded, sizeof(decPadded), "%010lu", (unsigned long)cardNumber);
    Serial.println("  Standard:      WG34 (34-bit)");
    Serial.println("  Card ID (Dec): " + String(cardNumber) +
                   " (8-Digit Boland: " + String(dec8) + ")");
    Serial.println("  Hex UID:       " + String(hexFormatted));

    // Primary UID matches the Boland 8-digit decimal setting (e.g. 19670374)
    outUid = String(cardNumber);
    outAltUid = String(dec8);

  } else if (bits == 32) {
    // Raw 32-bit (4-byte UID without parity)
    cardNumber = (uint32_t)(raw & 0xFFFFFFFF);
    snprintf(hexFormatted, sizeof(hexFormatted), "%02X %02X %02X %02X",
             (uint8_t)(cardNumber >> 24), (uint8_t)(cardNumber >> 16),
             (uint8_t)(cardNumber >> 8), (uint8_t)(cardNumber & 0xFF));
    char dec8[16];
    snprintf(dec8, sizeof(dec8), "%08lu", (unsigned long)(cardNumber % 100000000UL));
    snprintf(decPadded, sizeof(decPadded), "%010lu", (unsigned long)cardNumber);
    Serial.println("  Standard:      WG32 (32-bit Raw)");
    Serial.println("  Card ID (Dec): " + String(cardNumber) +
                   " (8-Digit Boland: " + String(dec8) + ")");
    Serial.println("  Hex UID:       " + String(hexFormatted));

    outUid = String(cardNumber);
    outAltUid = String(dec8);

  } else {
    // 37-bit (HID)
    cardNumber = (uint32_t)((raw >> 1) & 0xFFFFFFFF);
    snprintf(hexFormatted, sizeof(hexFormatted), "%02X %02X %02X %02X",
             (uint8_t)(cardNumber >> 24), (uint8_t)(cardNumber >> 16),
             (uint8_t)(cardNumber >> 8), (uint8_t)(cardNumber & 0xFF));
    char dec8[16];
    snprintf(dec8, sizeof(dec8), "%08lu", (unsigned long)(cardNumber % 100000000UL));
    snprintf(decPadded, sizeof(decPadded), "%010lu", (unsigned long)cardNumber);
    Serial.printf("  Standard:      %d-bit Wiegand\n", bits);
    Serial.println("  Card ID (Dec): " + String(cardNumber) +
                   " (8-Digit Boland: " + String(dec8) + ")");
    Serial.println("  Hex UID:       " + String(hexFormatted));

    outUid = String(cardNumber);
    outAltUid = String(dec8);
  }

  // Final sanity check: never pass 0xFFFFFFFF (4294967295) or 0
  if (cardNumber == 0xFFFFFFFF || cardNumber == 0 || outUid == "4294967295") {
    Serial.println("  [FILTER] Dropped invalid card number (0 or 4294967295)");
    outUid = "";
    outAltUid = "";
    return false;
  }

  Serial.println("========================================");
  return true;
}

// =====================================================
// 10B. BOLAND UHF SERIAL2 PACKET DECODER (Pins 16 & 17, Green & White wires)
// =====================================================
#if ENABLE_UHF_SERIAL2
bool checkUhfSerialReader(String &outUid, String &outAltUid) {
  outUid = "";
  outAltUid = "";

  static uint8_t rxBuf[256];
  static int rxLen = 0;
  static unsigned long lastRxMs = 0;
  static unsigned long lastPollCmdMs = 0;

  // 1. Send poll query only if reader has been silent for > 1500ms (prevents TX/RX bus collision)
  if (millis() - lastRxMs >= 1500 && millis() - lastPollCmdMs >= 1000) {
    lastPollCmdMs = millis();
    const uint8_t bolandPoll[] = {0xA0, 0x04, 0x01, 0x89, 0x01, 0xD1};
    Serial2.write(bolandPoll, sizeof(bolandPoll));
  }

  // 2. Read all available bytes into buffer
  while (Serial2.available() && rxLen < (int)sizeof(rxBuf)) {
    rxBuf[rxLen++] = Serial2.read();
    uhfTotalBytesReceived++;
    lastRxMs = millis();
  }

  // 3. If no data received yet, return immediately
  if (rxLen == 0) {
    return false;
  }

  // 4. Wait for packet burst to finish (idle for >= 15ms or buffer full)
  if (millis() - lastRxMs < 15 && rxLen < (int)sizeof(rxBuf)) {
    return false;
  }

  // Print raw bytes for immediate visual verification in Serial Monitor
  Serial.print("\n⚡ [UHF SERIAL2 RX] Received ");
  Serial.print(rxLen);
  Serial.print(" bytes: ");
  for (int i = 0; i < rxLen; i++) {
    if (rxBuf[i] < 0x10) Serial.print("0");
    Serial.print(rxBuf[i], HEX);
    Serial.print(" ");
  }
  Serial.println();

  bool allZeros = true;
  for (int i = 0; i < rxLen; i++) {
    if (rxBuf[i] != 0x00) { allZeros = false; break; }
  }
  if (allZeros) {
    static unsigned long lastZeroTip = 0;
    if (millis() - lastZeroTip >= 4000) {
      lastZeroTip = millis();
      Serial.printf("  ⚠️ [BAUD TIP] Received all 00s @ %u baud. Type '115200', '57600', '9600', or 'INVERT' in Serial Monitor to switch.\n",
                    currentUhfBaud);
    }
  }

  bool decoded = false;
  uint32_t cardNum = 0;

  // --- Decoding Strategy A: Standard UHF Frame (0xA0 Header) ---
  // Packet structure: [0xA0] [Len] [Addr] [Cmd] [Data...] [Checksum]
  for (int i = 0; i < rxLen; i++) {
    if (rxBuf[i] == 0xA0 && (i + 1 < rxLen)) {
      int frameLen = rxBuf[i + 1];
      // Total packet size is frameLen + 2 (Header + Len byte)
      if (i + frameLen + 1 < rxLen) {
        // Method 1: If PC word is present (Cmd 0x89 or 0xEE)
        if (frameLen >= 10 && (rxBuf[i + 3] == 0x89 || rxBuf[i + 3] == 0xEE)) {
          int epcLen = ((rxBuf[i + 5] >> 3) & 0x1F) * 2;
          if (epcLen <= 0 || epcLen > 32) epcLen = 12; // Standard 96-bit EPC is 12 bytes
          int epcEnd = i + 7 + epcLen;
          if (epcEnd <= i + frameLen + 1 && epcEnd - 4 >= i + 7) {
            cardNum = ((uint32_t)rxBuf[epcEnd - 4] << 24) |
                      ((uint32_t)rxBuf[epcEnd - 3] << 16) |
                      ((uint32_t)rxBuf[epcEnd - 2] << 8)  |
                      ((uint32_t)rxBuf[epcEnd - 1]);
            decoded = true;
            Serial.printf("  [UHF EPC DECODED] 32-bit ID: 0x%08X (%lu)\n", cardNum, (unsigned long)cardNum);
            break;
          }
        }
        // Method 2: Fallback to lowest 4 bytes
        if (!decoded) {
          int checkIdx = i + frameLen + 1;
          if (checkIdx - 4 >= i + 4) {
            cardNum = ((uint32_t)rxBuf[checkIdx - 4] << 24) |
                      ((uint32_t)rxBuf[checkIdx - 3] << 16) |
                      ((uint32_t)rxBuf[checkIdx - 2] << 8)  |
                      ((uint32_t)rxBuf[checkIdx - 1]);
            decoded = true;
            Serial.printf("  [UHF PACKET DECODED] 32-bit ID: 0x%08X (%lu)\n", cardNum, (unsigned long)cardNum);
            break;
          }
        }
      }
    }
  }

  // --- Decoding Strategy B: MagicRF Frame (0xBB Header ... 0x7E Tail) ---
  if (!decoded) {
    for (int i = 0; i < rxLen; i++) {
      if (rxBuf[i] == 0xBB) {
        for (int j = i + 1; j < rxLen; j++) {
          if (rxBuf[j] == 0x7E && (j - 4 >= i + 2)) {
            // Lowest 4 bytes before tail
            cardNum = ((uint32_t)rxBuf[j - 4] << 24) |
                      ((uint32_t)rxBuf[j - 3] << 16) |
                      ((uint32_t)rxBuf[j - 2] << 8)  |
                      ((uint32_t)rxBuf[j - 1]);
            decoded = true;
            Serial.printf("  [UHF 0xBB DECODED] 32-bit ID: 0x%08X (%lu)\n", cardNum, (unsigned long)cardNum);
            break;
          }
        }
        if (decoded) break;
      }
    }
  }

  // --- Decoding Strategy C: ASCII String (e.g. "19670374\r\n" or hex string) ---
  if (!decoded) {
    String asciiStr = "";
    for (int i = 0; i < rxLen; i++) {
      char c = (char)rxBuf[i];
      if (isdigit(c)) {
        asciiStr += c;
      }
    }
    if (asciiStr.length() >= 6 && asciiStr.length() <= 12) {
      cardNum = (uint32_t)asciiStr.toInt();
      decoded = true;
      Serial.println("  [UHF ASCII DECODED] Card: " + asciiStr);
    }
  }

  // --- Decoding Strategy D: Direct 4-Byte Payload ---
  if (!decoded && rxLen == 4) {
    cardNum = ((uint32_t)rxBuf[0] << 24) |
              ((uint32_t)rxBuf[1] << 16) |
              ((uint32_t)rxBuf[2] << 8)  |
              ((uint32_t)rxBuf[3]);
    decoded = true;
    Serial.printf("  [UHF RAW 4B DECODED] ID: %lu\n", (unsigned long)cardNum);
  }

  rxLen = 0; // Always reset buffer after processing

  if (decoded && cardNum > 0 && cardNum != 0xFFFFFFFF) {
    char dec8[16];
    snprintf(dec8, sizeof(dec8), "%08lu", (unsigned long)(cardNum % 100000000UL));
    outUid = String(cardNum);
    outAltUid = String(dec8);
    Serial.println("  ⚡ [UHF SERIAL MATCH] Extracted Card ID: " + outUid + " (8-Digit Boland: " + outAltUid + ")");
    return true;
  }

  return false;
}
#endif

// =====================================================
// 11. SETUP & INITIALIZATION
// =====================================================
void setup() {
  WRITE_PERI_REG(
      RTC_CNTL_BROWN_OUT_REG,
      0); // Prevent false brownout reboots during simultaneous WiFi TX + buzzer

  // NOTE: Do NOT call esp_bt_controller_mem_release(ESP_BT_MODE_CLASSIC_BT) here!
  // Arduino-ESP32's BLEDevice::init() -> btStart() initializes ESP_BT_MODE_BTDM
  // and hangs forever if CLASSIC_BT memory was pre-released before init.

  secureClient.setInsecure(); // Supabase HTTPS without root cert bundle
  secureClient.setHandshakeTimeout(3); // Cap TLS handshake to 3s max (prevents 120s network hang)
  Serial.begin(115200);
  delay(500);
  Serial.println("\n\n================================================");
  Serial.println("CHARRMPASS — Automated Vehicle UHF Monitor (~860–960 MHz)");
  Serial.println("Free-Flow Automated Drive-Through (No Mechanical Barrier)");
  Serial.println("================================================");

  // Peripherals
  pinMode(RED_LED, OUTPUT);
  pinMode(YELLOW_LED, OUTPUT);
  pinMode(GREEN_LED, OUTPUT);
  pinMode(BUZZER_PIN, OUTPUT);
  pinMode(RELAY_PIN, OUTPUT);
  pinMode(BOOT_BUTTON_PIN, INPUT_PULLUP); // Onboard BOOT button

  digitalWrite(RED_LED, HIGH);
  digitalWrite(YELLOW_LED, LOW);
  digitalWrite(GREEN_LED, LOW);
  digitalWrite(RELAY_PIN, HIGH); // Relay OFF

  // LCD Init
  Wire.begin(21, 22);
  Wire.setTimeOut(50); // 50ms I2C timeout prevents buck-converter power glitches from locking LCD
  lcd.begin(16, 2);
  lcdMsg("CHARRMPASS v4.5", "BOOTING GATE...");
  delay(1000);

  // Allocate dynamic RAM cache on Heap (prevents static DRAM overflow)
  ramCards = (RamCard *)calloc(MAX_RAM_CARDS, sizeof(RamCard));
  if (ramCards == NULL) {
    Serial.println("[ERROR] Failed to allocate RAM cache memory!");
  } else {
    Serial.println("[BOOT] Dynamic RAM cache allocated successfully (" + String(MAX_RAM_CARDS) + " cards).");
  }

  // Load persisted epoch time so offline scans retain valid timestamps even when booting offline
  preferences.begin("charrm_time", true);
  savedEpoch = preferences.getUInt("epoch", 0);
  preferences.end();
  bootMillisAtEpochLoad = millis();

// UHF Serial2 Hardware Init on GPIO 16 (RX2) and GPIO 17 (TX2)
#if ENABLE_UHF_SERIAL2
  // 1. Load UHF settings from NVS Flash (Defaults to INVERTED = true, 9600 baud)
  preferences.begin("charrm_uhf", true);
  invertUhfSerial = preferences.getBool("invert", true); // ALREADY INVERTED by default on boot
  currentUhfBaud = preferences.getUInt("baud", UHF_SERIAL_BAUD);
  preferences.end();

  // 2. Set pin mode and start Serial2 with inverted RS-232 logic
  if (invertUhfSerial) {
    pinMode(UHF_RX2_PIN, INPUT); // Floating input for active RS-232 driver (idle low)
  } else {
    pinMode(UHF_RX2_PIN, INPUT_PULLUP);
  }
  Serial2.end();
  Serial2.begin(currentUhfBaud, SERIAL_8N1, UHF_RX2_PIN, UHF_TX2_PIN, invertUhfSerial);
  Serial.printf("[UHF SERIAL2] Boland Reader ALREADY INVERTED on boot: GPIO %d (RX) & GPIO %d (TX) at %d baud (Invert=%s).\n",
                UHF_RX2_PIN, UHF_TX2_PIN, currentUhfBaud, invertUhfSerial ? "YES (INVERTED)" : "NO (NORMAL)");
#endif

// Wiegand UHF Reader Interrupt Init on GPIO 32 (PURPLE = D0) and GPIO 33 (GRAY = D1)
#if ENABLE_WIEGAND
  pinMode(WIEGAND_D0_PIN, INPUT_PULLUP);
  pinMode(WIEGAND_D1_PIN, INPUT_PULLUP);
  attachInterrupt(digitalPinToInterrupt(WIEGAND_D0_PIN), isrWiegandD0, FALLING);
  attachInterrupt(digitalPinToInterrupt(WIEGAND_D1_PIN), isrWiegandD1, FALLING);
  Serial.println("[WIEGAND] Boland UHF Reader initialized on GPIO 32 "
                 "(PURPLE=D0) and GPIO 33 (GRAY=D1) with pull-ups.");
#endif

// SPI Backup Reader Init
#if ENABLE_SPI_MFRC522
  SPI.begin(18, 19, 23, 5);
  rfid.PCD_Init();
  Serial.println("[RFID] SPI MFRC522 Backup Reader initialized.");
#endif

  // MicroSD Memory Module Init on dedicated HSPI (CS 13, MOSI 12, MISO 14, SCK 26)
  initSDCard();

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

  // 3. Load Saved Wi-Fi Credentials
  // Priority 1: SD Card (/wifi.cfg or /config/wifi.cfg)
  lcdMsg("LOADING CONFIG..", "CHECKING WIFI...");
  if (loadWifiFromSD(currentSsid, currentPass)) {
    Serial.println("[BOOT] Loaded Wi-Fi credentials from SD Card: '" + currentSsid + "'");
    saveWifiToNVS(currentSsid, currentPass);
  }

  // Priority 2: NVS Flash fallback (if SD was not present or had no file yet)
  if (currentSsid.length() == 0) {
    preferences.begin("charrm_wifi", true);
    currentSsid = preferences.getString("ssid", "");
    currentPass = preferences.getString("pass", "");
    preferences.end();
    if (currentSsid.length() > 0) {
      Serial.println("[BOOT] Loaded Wi-Fi credentials from NVS Flash: '" + currentSsid + "'");
      saveWifiToSD(currentSsid, currentPass);
    }
  }

  // Priority 3: Default code constants (DEFAULT_WIFI_SSID) if SD & NVS are empty
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
    bool ok = attemptWifiConnection(currentSsid, currentPass, 15);
    if (!ok) {
      Serial.println("[BOOT] Wi-Fi failed after 3 attempts. Operating in Offline SD Cache Mode with BLE Open.");
    }
  } else {
    Serial.println("[BOOT] No saved Wi-Fi credentials found in SD, NVS, or code.");
    Serial.println("[BOOT] Starting BLE server for wireless Web provisioning...");
    inBleSetupMode = true;
    startBleServer();
  }

  // Prioritize physical gate operation: Make gate ready immediately using local RAM/SD cache!
  showReady();

  // If connected, sync database in the background without blocking gate readiness
  if (wifiConnected && WiFi.status() == WL_CONNECTED) {
    Serial.println("[BOOT] Gate is active. Starting initial cloud sync in background...");
    syncWhitelistToRam();
    flushOfflineTransactions();
    sendDeviceHeartbeat();
    showReady();
  }
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
                     "Forcing Forget Wi-Fi & BLE Setup Mode!");
      forgetWifiAndStartBle();
      showReady();
      bootButtonPressStart = 0;
      while (digitalRead(BOOT_BUTTON_PIN) == LOW) {
        delay(10);
      } // Wait for button release
    }
  } else {
    bootButtonPressStart = 0;
  }

  // ── DIRECT BLE FORGET COMMAND FROM WEB APP ──
  if (bleForgetRequested) {
    bleForgetRequested = false;
    forgetWifiAndStartBle();
    showReady();
  }

  // ── BLE EVENTS (raised by BLE callbacks, handled safely here) ──
  if (bleEvtConnected) {
    bleEvtConnected = false;
    Serial.println("\n[BLE] Web Client Connected via Bluetooth!");
    inBleSetupMode = true;
    lcdMsg("BLUETOOTH PAIRED", "ENCODE SSID&PASS");
    beep(100, 2);
  }
  if (bleEvtDisconnected) {
    bleEvtDisconnected = false;
    Serial.println("[BLE] Web Client Disconnected.");
    // Only re-advertise if we still need provisioning (i.e. offline)
    if (bleServerRunning && !wifiConnected && !newWifiCredentialsReceived) {
      BLEDevice::getAdvertising()->start();
      BLEDevice::startAdvertising();
      Serial.println("[BLE] Advertising resumed (device still offline in BLE Setup Mode).");
    }
    showReady();
  }

  // ── BLE PROVISIONING: Web -> Bluetooth -> ESP32 -> SD Card -> Wi-Fi ──
  if (newWifiCredentialsReceived) {
    String newSsid = pendingBleSsid;
    String newPass = pendingBlePass;
    newWifiCredentialsReceived = false;

    Serial.println("\n=======================================================");
    Serial.println("📲 [BLE PROVISION] Received SSID: '" + newSsid + "' (" +
                   String(newPass.length()) + " char password)");
    Serial.println("=======================================================");
    lcdMsg("WIFI RECEIVED", newSsid.substring(0, 16));
    beep(150, 1);
    delay(400);

    // STEP 1: Save new Wi-Fi credentials to SD Card (/wifi.cfg) & NVS FIRST
    lcdMsg("SAVING TO SD...", newSsid.substring(0, 16));
    saveWifiToSD(newSsid, newPass);
    saveWifiToNVS(newSsid, newPass);
    currentSsid = newSsid;
    currentPass = newPass;

    // STEP 2: Notify Web App that credentials were saved to SD, then stop BLE to free RAM
    sendBleStatus("{\"event\":\"SAVED\",\"ssid\":\"" + newSsid + "\"}");
    lcdMsg("SD CARD SAVED!", "CONNECTING WIFI");
    beep(150, 1);
    delay(600); // Allow BLE notification packet to flush to browser before stopping BLE

    // STEP 3: Stop BLE stack (frees ~105KB DRAM) and connect to Wi-Fi (max 3 attempts)
    stopBleAndFreeRam();
    bool ok = attemptWifiConnection(newSsid, newPass, 25);
    if (ok) {
      inBleSetupMode = false;
      syncWhitelistToRam();
      flushOfflineTransactions();
    } else {
      // attemptWifiConnection() already set inBleSetupMode = true and called startBleServer()
      Serial.println("[BLE PROVISION] ❌ Wi-Fi failed after 3 attempts. Staying in Offline Mode with BLE Open for re-encoding.");
      inBleSetupMode = true;
      if (!bleServerRunning) {
        startBleServer();
      }
    }
    lastWifiRetryMs = millis();
    showReady();
  }

  // Periodic Wi-Fi watchdog, Fast Remote Command Poll (5s), & Heartbeat (60s)
  if (WiFi.status() == WL_CONNECTED) {
    if (!wifiConnected) {
      wifiConnected = true;
      internetAvailable = true;
      inBleSetupMode = false;
      WiFi.setTxPower(WIFI_POWER_15dBm);
      applyWifiPowerSave();
      if (WiFi.dnsIP() == IPAddress(0, 0, 0, 0)) {
        WiFi.setDNS(IPAddress(8, 8, 8, 8), IPAddress(1, 1, 1, 1));
      }
      configTime(0, 0, "pool.ntp.org", "time.google.com");
      Serial.println("[WIFI] Reconnected to network! IP: " +
                     WiFi.localIP().toString());
      stopBleAndFreeRam();
      if (ramCards == NULL) {
        loadWhitelistFromSD();
      }
      sendDeviceHeartbeat();
      syncWhitelistToRam();
      flushOfflineTransactions();
      lastHeartbeat = millis();
      lastRemoteCmdCheck = millis();
      showReady();
    }
    if (millis() - lastRemoteCmdCheck >= REMOTE_CMD_CHECK_INTERVAL) {
      lastRemoteCmdCheck = millis();
      checkRemoteWifiCommand();
    }
    if (wifiConnected && millis() - lastHeartbeat >= HEARTBEAT_INTERVAL) {
      lastHeartbeat = millis();
      sendDeviceHeartbeat();
    }
  } else {
    if (wifiConnected) {
      wifiConnected = false;
      internetAvailable = false;
      lastWifiRetryMs = millis();
      Serial.println("[WIFI] Lost Wi-Fi connection. Operating in Offline SD "
                     "Cache Mode...");
      spillRamQueueToSd();
      showReady();
    } else if (inBleSetupMode && !bleServerRunning) {
      startBleServer();
      showReady();
    } else if (currentSsid.length() > 0 && !inBleSetupMode && !bleClientConnected &&
               !newWifiCredentialsReceived &&
               (millis() - lastWifiRetryMs >= WIFI_RETRY_INTERVAL)) {
      lastWifiRetryMs = millis();
      Serial.println("[WIFI WATCHDOG] Background reconnect to '" + currentSsid + "'...");
      if (WiFi.getMode() != WIFI_STA) {
        WiFi.mode(WIFI_STA);
        WiFi.setTxPower(WIFI_POWER_11dBm);
      }
      WiFi.setAutoReconnect(true);
      if (currentPass.length() > 0) {
        WiFi.begin(currentSsid.c_str(), currentPass.c_str());
      } else {
        WiFi.begin(currentSsid.c_str(), NULL);
      }
    }
  }

  // 0. Periodic internet recovery probe if offline while Wi-Fi is connected
  if (wifiConnected && !internetAvailable && (millis() - lastInternetProbeMs >= INTERNET_PROBE_INTERVAL)) {
    lastInternetProbeMs = millis();
    WiFiClientSecure probeClient;
    probeClient.setInsecure();
    probeClient.setHandshakeTimeout(2);
    HTTPClient probeHttp;
    probeHttp.begin(probeClient, String(SUPABASE_URL) + "/rest/v1/");
    probeHttp.setTimeout(2500);
    probeHttp.addHeader("apikey", SUPABASE_ANON);
    int pCode = probeHttp.GET();
    probeHttp.end();
    if (pCode > 0) {
      Serial.printf("[NET WATCHDOG] Internet restored! (HTTP %d)\n", pCode);
      internetAvailable = true;
      consecutiveNetFails = 0;
      showReady();
    }
  }

  // 1. Process asynchronous background cloud transactions whenever Wiegand is idle
  processCloudQueue();
  flushOfflineTransactions();

  // 2. Periodic RAM Whitelist Sync from Supabase (every 5 minutes)
  if (wifiConnected && internetAvailable &&
      (millis() - lastWhitelistSync >= WHITELIST_SYNC_INTERVAL)) {
    lastWhitelistSync = millis();
    syncWhitelistToRam();
  }

  // 3. Reset LCD display to ready screen after scan display hold time
  if (readyDisplayAtMillis > 0 && millis() >= readyDisplayAtMillis) {
    readyDisplayAtMillis = 0;
    showReady();
  }

  // ── OFFLINE STATUS INDICATOR: Non-blocking blinking yellow LED ──
  // Blinks Yellow (500ms ON, 500ms OFF) when offline without blocking UHF reads
  if (readyDisplayAtMillis == 0 && (!wifiConnected || WiFi.status() != WL_CONNECTED || !internetAvailable)) {
    static unsigned long lastOfflineBlink = 0;
    static bool offlineYellowState = true;
    if (millis() - lastOfflineBlink >= 500) {
      lastOfflineBlink = millis();
      offlineYellowState = !offlineYellowState;
      setTrafficLight(false, offlineYellowState, false);
    }
  }

  // Serial input: RESET: to clear credentials, or manual UID
  if (Serial.available() > 0) {
    String inputStr = Serial.readStringUntil('\n');
    inputStr.trim();
    if (inputStr.length() > 0) {

      // ── WIFI:<SSID>,<PASS>  → Save to SD & NVS and connect ──
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

        Serial.println("\n[SERIAL PROVISION] Saving & connecting to SSID: '" +
                       currentSsid + "'...");
        lcdMsg("SAVING TO SD...", currentSsid.substring(0, 16));
        beep(200, 1);
        saveWifiToSD(currentSsid, currentPass);
        saveWifiToNVS(currentSsid, currentPass);
        bool ok = attemptWifiConnection(currentSsid, currentPass, 15);
        if (ok) {
          syncWhitelistToRam();
          flushOfflineTransactions();
        } else {
          startBleServer();
        }
        showReady();
        return;
      }

      // ── RESET / FORGET → Wipe NVS credentials and SD backup & start BLE ──
      if (inputStr.equalsIgnoreCase("RESET:") ||
          inputStr.equalsIgnoreCase("RESET") ||
          inputStr.equalsIgnoreCase("FORGET") ||
          inputStr.equalsIgnoreCase("FORGET:")) {
        forgetWifiAndStartBle();
        showReady();
        return;
      }

      // ── UHF BAUD:57600, BAUD:115200, BAUD:9600 or direct number ──
      if (inputStr.equalsIgnoreCase("57600") || inputStr.equalsIgnoreCase("115200") ||
          inputStr.equalsIgnoreCase("9600")  || inputStr.equalsIgnoreCase("38400") ||
          inputStr.equalsIgnoreCase("19200") ||
          inputStr.startsWith("BAUD:") || inputStr.startsWith("baud:")) {
        uint32_t newBaud = 0;
        if (inputStr.startsWith("BAUD:") || inputStr.startsWith("baud:")) {
          newBaud = inputStr.substring(5).toInt();
        } else {
          newBaud = inputStr.toInt();
        }
        if (newBaud >= 2400 && newBaud <= 256000) {
          currentUhfBaud = newBaud;
          preferences.begin("charrm_uhf", false);
          preferences.putUInt("baud", currentUhfBaud);
          preferences.end();
          Serial2.end();
          if (invertUhfSerial) {
            pinMode(UHF_RX2_PIN, INPUT);
          } else {
            pinMode(UHF_RX2_PIN, INPUT_PULLUP);
          }
          Serial2.begin(currentUhfBaud, SERIAL_8N1, UHF_RX2_PIN, UHF_TX2_PIN, invertUhfSerial);
          Serial.printf("\n⚡ [UHF SERIAL2] Switched baud rate to %u baud (Invert=%s) & saved to NVS!\n",
                        currentUhfBaud, invertUhfSerial ? "YES" : "NO");
          return;
        }
      }

      // ── INVERT / INVERT: → Toggle logic inversion (for RS232 signals) ──
      if (inputStr.equalsIgnoreCase("INVERT") || inputStr.equalsIgnoreCase("INVERT:")) {
        invertUhfSerial = !invertUhfSerial;
        preferences.begin("charrm_uhf", false);
        preferences.putBool("invert", invertUhfSerial);
        preferences.end();
        Serial2.end();
        if (invertUhfSerial) {
          pinMode(UHF_RX2_PIN, INPUT);
        } else {
          pinMode(UHF_RX2_PIN, INPUT_PULLUP);
        }
        Serial2.begin(currentUhfBaud, SERIAL_8N1, UHF_RX2_PIN, UHF_TX2_PIN, invertUhfSerial);
        Serial.printf("\n⚡ [UHF SERIAL2] Toggled signal inversion! Now: %s at %u baud (Saved to NVS)!\n",
                      invertUhfSerial ? "INVERTED" : "NORMAL", currentUhfBaud);
        return;
      }

      // ── Manual tag UID for testing ──
      String testUid = inputStr;
      testUid.toUpperCase();
      Serial.println("[MANUAL] Simulating UHF tag: " + testUid);
      handleScannedTag(testUid);
    }
  }

// 4. Poll Boland Long-Range UHF UART Serial2 (White=TX/ESP-RX16, Green=RX/ESP-TX17)
#if ENABLE_UHF_SERIAL2
  String serialUid = "";
  String serialAlt = "";
  if (checkUhfSerialReader(serialUid, serialAlt)) {
    handleScannedTag(serialUid, serialAlt);
  }
#endif

// 5. Poll Boland Long-Range UHF Wiegand Reader
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

  // 6. Live Hardware Diagnostics (Printed every 6 seconds)
  static unsigned long lastHardwareDiag = 0;
  if (millis() - lastHardwareDiag >= 6000) {
    lastHardwareDiag = millis();
    int rx_16 = digitalRead(UHF_RX2_PIN);
    int tx_17 = digitalRead(UHF_TX2_PIN);
    int d0_32 = digitalRead(WIEGAND_D0_PIN);
    int d1_33 = digitalRead(WIEGAND_D1_PIN);
    Serial.printf("[HARDWARE MONITOR @ %u baud%s] Serial2 Pin 16(RX)=%s | Pin 17(TX)=%s | RX Bytes=%u || Wiegand G32(D0)=%s | G33(D1)=%s | Pulses=%u\n",
                  currentUhfBaud,
                  invertUhfSerial ? " (INV)" : "",
                  rx_16 ? "HIGH (IDLE)" : "LOW (ACTIVE)",
                  tx_17 ? "HIGH" : "LOW",
                  uhfTotalBytesReceived,
                  d0_32 ? "HIGH" : "LOW",
                  d1_33 ? "HIGH" : "LOW",
                  wiegandTotalPulses);
  }

  delayMicroseconds(200); // High-frequency polling (zero lag)
}
