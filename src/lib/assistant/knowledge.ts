import "server-only";

/**
 * The tech desk's reference knowledge (blueprint §10.11, §17.1 consumer-electronics row,
 * BUILD_SPEC §1 KNOWLEDGE_DOMAIN). ONE constant, terse — every word is paid for on every message —
 * with UPPERCASE section labels. General, well-established facts only: nothing here is a claim
 * about a product or about this store (the catalogue, the tools and STORE FACTS carry those), and
 * the market-specific section (Sri Lankan power, plugs, climate, warranty) is the one that changes
 * buying decisions here.
 *
 * Sources checked when writing it (Sept 2026): USB-IF / Intel naming for USB 3.2, USB4 and
 * Thunderbolt 4/5 speeds; IEC 60529 IP codes; SATA III vs NVMe PCIe Gen 3/4/5 sequential speeds;
 * exFAT/NTFS/APFS cross-platform support; Sri Lanka mains 230 V 50 Hz with type D, G and M sockets.
 */
export const KNOWLEDGE = `CPU
Tier within a generation: Intel Core i3/i5/i7/i9 and Core Ultra 5/7/9; AMD Ryzen 3/5/7/9 and Ryzen AI 5/7/9. A newer generation often beats an older higher tier, so compare the generation, not just the number. Laptop suffixes: U/P = low power, longer battery; H/HS/HX = high performance, more heat, shorter battery. Arm laptops (Qualcomm Snapdragon X): long battery life and most apps run, but some older games, anti-cheat, drivers and specialist software may not — check before recommending one for those.

GPU
Integrated graphics (Intel Iris Xe/Arc, AMD Radeon) handle office work, video and light games. Dedicated NVIDIA GeForce RTX: within a series a higher number is faster (4050 < 4060 < 4070 < 4080 < 4090; the 50 series likewise). A laptop GPU's speed also depends on its power limit (TGP, watts), so the same chip varies between laptops. More VRAM helps games at high settings, video and 3D.

RAM, STORAGE, DISPLAY, BATTERY
RAM: 8 GB = basic browsing and documents; 16 GB = the sensible default; 32 GB+ = video editing, 3D, heavy multitasking. Soldered RAM cannot be upgraded later. Boot drive: an SSD, never an HDD; 256 GB fills fast, 512 GB–1 TB is comfortable. Drives are sold in decimal units (1 TB = 1,000 GB) but Windows counts in binary, so a 1 TB drive shows about 931 GB — nothing is missing. Display: 1920×1080 is standard; 60 Hz is fine for work, 120–165 Hz+ is smoother and matters for gaming; IPS and OLED give better colour and viewing angles; creators want high sRGB/DCI-P3 coverage. Battery: capacity in Wh; real runtime depends on the task, brightness and power mode — gaming laptops last far less on battery. Weight: about 1.0–1.4 kg is easy to carry daily; gaming and 16-inch creator laptops are often 2 kg or more.

NVME VS SATA
SATA SSDs top out around 550 MB/s. NVMe SSDs use PCIe: Gen 3 up to about 3,500 MB/s, Gen 4 about 7,000, Gen 5 about 14,000. M.2 is a shape, not a speed: an M.2 slot can be SATA or NVMe, so check what the laptop or board supports.

USB, THUNDERBOLT, USB-C
USB-C is a connector shape, not a speed. USB 2.0 = 480 Mb/s; USB 3.2 Gen 1 (also sold as USB 3.0 / 3.1 Gen 1) = 5 Gb/s; USB 3.2 Gen 2 = 10 Gb/s; USB 3.2 Gen 2x2 = 20 Gb/s; USB4 = 40 Gb/s (USB4 v2 80); Thunderbolt 3/4 = 40 Gb/s; Thunderbolt 5 = 80 Gb/s (up to 120 in one direction). A link runs at the speed of its slowest part: port, cable or drive. Typical portable SSD speeds: about 400–450 MB/s on a 5 Gb/s port, about 1,000 MB/s on 10 Gb/s, about 2,000 MB/s on 20 Gb/s (Gen 2x2 ports are uncommon; such drives fall back to 10 Gb/s elsewhere). A USB-C port may or may not carry video (DisplayPort) or charging (USB Power Delivery) — check the laptop's spec; USB-C charging needs a charger with enough watts for that laptop.

SSD VS HDD, PORTABLE STORAGE
HDD: cheapest per terabyte and the biggest capacities, but slower (roughly 100–250 MB/s) and fragile if knocked while running; 3.5-inch desktop drives need mains power, 2.5-inch portables run from USB. SSD: several times faster, silent, shock-resistant — best for big files and working off the drive. Flash drives: handy for transfers, slower, not ideal as the only backup. Backups: 3 copies, on 2 kinds of media, 1 kept somewhere else (3-2-1). Ruggedness: IP code first digit = dust (6 = dust-tight), second = water (5 = water jets, 7 = immersion to 1 m for 30 minutes); drop ratings are the maker's claim — quote only what the spec says. Formats: exFAT reads and writes on both Windows and Mac; NTFS is read-only on a Mac without extra software; APFS is Mac-only; reformatting erases the drive.

KEYBOARDS
Switches: linear (smooth, often "red"), tactile (a bump, often "brown"), clicky (bump plus click, often "blue") — colour names vary by brand. Membrane and scissor keys are quieter and flatter (low-profile, laptop-like). Hot-swap sockets let you change switches without soldering (check 3-pin vs 5-pin). Layouts: full-size (number pad), TKL (no number pad), 75% (compact, keeps F-row and arrows), 65% (no F-row, keeps arrows), 60% (no F-row or arrow keys; reached through an Fn layer). Connection: wired = lowest latency, nothing to charge; 2.4 GHz dongle = low latency, good for gaming; Bluetooth = several devices, no dongle, slightly more latency; tri-mode = all three. Mac users: look for a Mac mode or Mac keycaps. PBT keycaps resist shine better than ABS.

MICE
Optical sensors track on most surfaces; maximum DPI is mostly marketing — most people use 800–3,200. 1,000 Hz polling is standard for gaming. Under about 60 g is ultralight, for fast aim; heavier feels steadier. Grip: palm (whole hand, larger ergonomic shapes), claw (arched fingers), fingertip (small, light mice). Vertical mice keep the hand in a handshake position to reduce forearm twisting. Silent switches suit offices and shared rooms. Wireless: 2.4 GHz for low latency, Bluetooth for multi-device and travel.

COMPATIBILITY
Standard USB and Bluetooth keyboards, mice and drives work with Windows, macOS, ChromeOS and Linux; companion software (macros, lighting) is often Windows/Mac only. Check the ports the shopper has (USB-A vs USB-C; adapters exist) before recommending a peripheral or a laptop.

SRI LANKA
Mains 230 V, 50 Hz. Sockets: type D (three round pins) and type G (three rectangular pins) are common; type M (large round pins) for heavy appliances. Most laptop chargers are rated 100–240 V (check the label) and need only the right plug or a proper adapter. Voltage fluctuations, surges and outages happen, especially in thunderstorms: a UPS (battery backup, ideally with AVR) for desktops and routers, a surge protector for laptops and chargers, and unplug during lightning. Heat and humidity: keep devices ventilated and dry, store drives with silica gel, and let a device reach room temperature before switching it on after coming out of air-conditioning (condensation). Dust: clean vents gently; use laptops on hard, flat surfaces.
Warranty: an official (local) warranty is honoured through the brand's authorised local distributor or service agent; units imported privately may not be covered. Keep the invoice. Warranties usually exclude physical, liquid and power-surge damage. State a product's warranty ONLY when get_product_details or STORE FACTS gives one.

USE CASES
Students and office: a light laptop, Core i5 / Ryzen 5 class (i3 / Ryzen 3 for basic tasks), 16 GB RAM (8 GB minimum), 512 GB SSD, good battery; a quiet wireless mouse and keyboard. Gaming: dedicated RTX graphics (4060 class or better for 1080p at high settings), 144 Hz+ screen, 16 GB+ RAM, good cooling; a light gaming mouse and a mechanical keyboard. Creators: 32 GB RAM, a strong H-series CPU, RTX 4070-class graphics for video and 3D, a colour-accurate screen, a fast 1 TB+ SSD plus a backup drive. Travel: under about 1.4 kg, long battery, USB-C charging, a compact Bluetooth mouse, a portable SSD.

SAFETY
Never advise unsafe modifications: opening or puncturing batteries, using a swollen or damaged battery (stop using it and get it serviced), bypassing chargers or safety features, uncertified chargers, or over-volting beyond the maker's settings. After a liquid spill: switch off and unplug at once and don't power it on until it has been checked.`;
