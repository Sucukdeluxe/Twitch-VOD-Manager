import sys
import subprocess
import os
import datetime
import threading
import time
import json
import traceback
import re
import tkinter as tk
from tkinter import messagebox, filedialog
from io import BytesIO
from concurrent.futures import ThreadPoolExecutor
from typing import Optional, Dict, Any, List, Callable

# ==========================================
# 0. CONFIG & SETUP
# ==========================================
APP_VERSION = "v3.5.3"
UPDATE_CHECK_URL = "http://24-music.de/version.json"
# Programmverzeichnis ermitteln (funktioniert auch bei EXE)
PROGRAM_DIR = os.path.dirname(os.path.abspath(sys.argv[0]))
# Settings in ProgramData speichern (für Installer-Installation)
APPDATA_DIR = os.path.join(os.environ.get('PROGRAMDATA', 'C:\\ProgramData'), 'Twitch_VOD_Manager')
if not os.path.exists(APPDATA_DIR):
    try:
        os.makedirs(APPDATA_DIR, exist_ok=True)
    except:
        APPDATA_DIR = PROGRAM_DIR  # Fallback auf Programmverzeichnis
CONFIG_FILE = os.path.join(APPDATA_DIR, "config.json")
QUEUE_FILE = os.path.join(APPDATA_DIR, "download_queue.json")
# Standard Download-Ordner auf Desktop
DEFAULT_DOWNLOAD_PATH = os.path.join(os.path.expanduser("~"), "Desktop", "Twitch_VODs")
ESTIMATED_BYTES_PER_SEC = 750 * 1024
os.environ["OPENCV_LOG_LEVEL"] = "OFF"

# ==========================================
# CONSTANTS
# ==========================================
# Windows Process Creation Flag
CREATE_NO_WINDOW = 0x08000000

# File Size Thresholds (MB)
MIN_VALID_FILE_SIZE_MB = 1.0
MIN_PART_SIZE_MB = 15.0

# Timeouts (Sekunden)
THUMBNAIL_TIMEOUT = 5
API_TIMEOUT = 10
YOUTUBE_LOGIN_TIMEOUT = 180
YOUTUBE_UPLOAD_TIMEOUT = 7200

# Retry Settings
MAX_RETRY_ATTEMPTS = 3
RETRY_DELAY_SECONDS = 5

# Thread Pool Settings
MAX_THUMBNAIL_WORKERS = 8

# ==========================================
# THEME DEFINITIONS
# ==========================================
THEMES = {
    "Default": {
        "bg_main": "#242424", "bg_sidebar": "#2b2b2b", "bg_card": "#333333",
        "accent": "#1f538d", "accent_hover": "#14375e", "text": "#DCE4EE",
        "text_secondary": "#888888", "tab_text_active": "white",
        "border_width": 0, "border_color": "#333333",
        "button_border_width": 1, "button_border_color": "#444444",
        "corner_radius": 8, "button_corner_radius": 8, "entry_corner_radius": 6,
        "font_family": "Segoe UI", "font_size_title": 22, "font_size_normal": 14, "font_size_small": 12,
    },
    "Discord": {
        "bg_main": "#36393f", "bg_sidebar": "#202225", "bg_card": "#2f3136",
        "accent": "#5865F2", "accent_hover": "#4752C4", "text": "#dcddde",
        "text_secondary": "#72767d", "tab_text_active": "white",
        "border_width": 0, "border_color": "#2f3136",
        "button_border_width": 0, "button_border_color": "transparent",
        "corner_radius": 4, "button_corner_radius": 3, "entry_corner_radius": 3,
        "font_family": "Whitney", "font_size_title": 20, "font_size_normal": 14, "font_size_small": 12,
    },
    "Twitch": {
        "bg_main": "#0e0e10", "bg_sidebar": "#18181b", "bg_card": "#1f1f23",
        "accent": "#9146FF", "accent_hover": "#772ce8", "text": "#efeff1",
        "text_secondary": "#adadb8", "tab_text_active": "white",
        "border_width": 0, "border_color": "#1f1f23",
        "button_border_width": 1, "button_border_color": "#9146FF",
        "corner_radius": 4, "button_corner_radius": 4, "entry_corner_radius": 4,
        "font_family": "Inter", "font_size_title": 22, "font_size_normal": 14, "font_size_small": 12,
    },
    "YouTube": {
        "bg_main": "#0f0f0f", "bg_sidebar": "#0f0f0f", "bg_card": "#1e1e1e",
        "accent": "#FF0000", "accent_hover": "#cc0000", "text": "#ffffff",
        "text_secondary": "#aaaaaa", "tab_text_active": "white",
        "border_width": 2, "border_color": "#333333",
        "button_border_width": 1, "button_border_color": "#333333",
        "corner_radius": 12, "button_corner_radius": 18, "entry_corner_radius": 8,
        "font_family": "Roboto", "font_size_title": 24, "font_size_normal": 14, "font_size_small": 12,
    },
    "Apple": {
        "bg_main": "#1c1c1e", "bg_sidebar": "#2c2c2e", "bg_card": "#3a3a3c",
        "accent": "#0A84FF", "accent_hover": "#0071e3", "text": "#f5f5f7",
        "text_secondary": "#86868b", "tab_text_active": "white",
        "border_width": 0, "border_color": "#48484a",
        "button_border_width": 1, "button_border_color": "#48484a",
        "corner_radius": 14, "button_corner_radius": 12, "entry_corner_radius": 10,
        "font_family": "SF Pro Display", "font_size_title": 22, "font_size_normal": 15, "font_size_small": 13,
    },
    "Apple Light": {
        "bg_main": "#f5f5f7", "bg_sidebar": "#e8e8ed", "bg_card": "#ffffff",
        "accent": "#007AFF", "accent_hover": "#0051a8", "text": "#1d1d1f",
        "text_secondary": "#86868b", "tab_text_active": "white",
        "border_width": 1, "border_color": "#d2d2d7",
        "button_border_width": 1, "button_border_color": "#c7c7cc",
        "corner_radius": 14, "button_corner_radius": 12, "entry_corner_radius": 10,
        "font_family": "SF Pro Display", "font_size_title": 22, "font_size_normal": 15, "font_size_small": 13,
    }
}

# ==========================================
# HELPER FUNCTIONS
# ==========================================
def log_crash(e, filename="CRASH_LOG.txt"):
    error_msg = f"ZEIT: {datetime.datetime.now()}\nERROR: {e}\n\n{traceback.format_exc()}"
    try:
        with open(filename, "w", encoding="utf-8") as f:
            f.write(error_msg)
    except:
        pass
    print("CRASH:", e)

def get_streamlink_cmd():
    """Gibt den Streamlink-Befehl zurück (funktioniert auch als EXE)."""
    import shutil
    # Versuche streamlink direkt zu finden
    streamlink_path = shutil.which("streamlink")
    if streamlink_path:
        return [streamlink_path]
    # Fallback: Python Scripts Ordner
    if os.name == 'nt':
        scripts_path = os.path.join(os.path.dirname(sys.executable), "Scripts", "streamlink.exe")
        if os.path.exists(scripts_path):
            return [scripts_path]
    # Letzter Fallback: python -m streamlink (funktioniert nur als .pyw)
    return [sys.executable, "-m", "streamlink"]

def install_dependencies():
    if getattr(sys, 'frozen', False): 
        return
    required_map = {
        "requests": "requests", 
        "customtkinter": "customtkinter", 
        "streamlink": "streamlink",
        "packaging": "packaging", 
        "Pillow": "PIL", 
        "imageio-ffmpeg": "imageio_ffmpeg",
        "opencv-python": "cv2", 
        "selenium": "selenium"
    }
    missing = []
    for pkg, imp in required_map.items():
        try: 
            __import__(imp)
        except ImportError: 
            missing.append(pkg)
    
    if missing:
        print(f"Installiere fehlende Pakete: {missing}...")
        startupinfo = subprocess.STARTUPINFO()
        startupinfo.dwFlags |= subprocess.STARTF_USESHOWWINDOW
        try: 
            subprocess.call([sys.executable, "-m", "pip", "install", *missing], stdout=subprocess.PIPE, stderr=subprocess.PIPE, startupinfo=startupinfo, creationflags=CREATE_NO_WINDOW if os.name == 'nt' else 0)
        except: 
            pass

# Abhängigkeiten prüfen
try: 
    install_dependencies()
except: 
    pass

try:
    import requests
    import customtkinter as ctk
    from PIL import Image, ImageTk
    import imageio_ffmpeg
    import cv2
    from selenium import webdriver
    from selenium.webdriver.common.by import By
    from selenium.webdriver.firefox.service import Service
    from selenium.webdriver.firefox.options import Options
except Exception as e:
    log_crash(f"Import Fehler: {e}")
    # GUI Fallback falls möglich, sonst exit
    import tkinter
    root = tkinter.Tk()
    root.withdraw()
    messagebox.showerror("Fatal Error", f"Fehler beim Starten:\n{e}\n\nSiehe CRASH_LOG.txt")
    sys.exit()

ctk.set_appearance_mode("Dark")
ctk.set_default_color_theme("dark-blue")

# ==========================================
# CUSTOM WIDGETS
# ==========================================
class VideoTimeline(tk.Canvas):
    def __init__(self, master, width=800, height=40, bg="#1a1a1a", select_color="#E5A00D", command=None, **kwargs):
        super().__init__(master, width=width, height=height, bg=bg, highlightthickness=0, **kwargs)
        self.command = command
        self.select_color = select_color
        self.width, self.height = width, height
        self.start_pos, self.end_pos = 0.0, 1.0
        self.dragging = None
        self.bind("<Configure>", self.on_resize)
        self.bind("<Button-1>", self.on_click)
        self.bind("<B1-Motion>", self.on_drag)
        self.bind("<ButtonRelease-1>", self.on_release)
        self.draw()

    def on_resize(self, event):
        self.width, self.height = event.width, event.height
        self.draw()

    def draw(self):
        self.delete("all")
        x_s = self.start_pos * self.width
        x_e = self.end_pos * self.width
        self.create_rectangle(0, 10, self.width, self.height-10, fill="#333333", width=0)
        self.create_rectangle(x_s, 10, x_e, self.height-10, fill=self.select_color, width=0)
        self.create_rectangle(x_s-5, 5, x_s+5, self.height-5, fill="white", outline="gray", width=1)
        self.create_rectangle(x_e-5, 5, x_e+5, self.height-5, fill="white", outline="gray", width=1)

    def on_click(self, event):
        x = event.x
        if abs(x - self.start_pos*self.width) < 15: self.dragging = 'start'
        elif abs(x - self.end_pos*self.width) < 15: self.dragging = 'end'
        else: self.dragging = 'start' if abs(x - self.start_pos*self.width) < abs(x - self.end_pos*self.width) else 'end'
        self.update_pos(x, self.dragging)

    def on_drag(self, event):
        if self.dragging: self.update_pos(event.x, self.dragging)

    def on_release(self, event): self.dragging = None

    def update_pos(self, x, handle):
        if self.width <= 0:
            return
        ratio = max(0, min(x, self.width)) / self.width
        if handle == 'start': self.start_pos = min(ratio, self.end_pos - 0.001)
        elif handle == 'end': self.end_pos = max(ratio, self.start_pos + 0.001)
        self.draw()
        if self.command: self.command(self.start_pos, self.end_pos, handle)

    def set_values(self, start, end):
        self.start_pos, self.end_pos = max(0.0, min(1.0, start)), max(0.0, min(1.0, end))
        self.draw()

class CTkToolTip:
    def __init__(self, widget, message):
        self.widget = widget
        self.message = message
        self.tooltip_window = None
        self.widget.bind("<Enter>", self.show)
        self.widget.bind("<Leave>", self.hide)
        
    def show(self, event=None):
        if self.tooltip_window or not self.message: return
        try:
            x = self.widget.winfo_rootx() + 25
            y = self.widget.winfo_rooty() + self.widget.winfo_height() + 5
            self.tooltip_window = tk.Toplevel(self.widget)
            self.tooltip_window.wm_overrideredirect(True)
            self.tooltip_window.wm_geometry(f"+{x}+{y}")
            tk.Label(self.tooltip_window, text=self.message, justify='left', background="#2b2b2b", fg="white", relief='solid', borderwidth=1, font=("Segoe UI", 9)).pack(ipadx=3, ipady=3)
        except: pass
        
    def hide(self, event=None):
        if self.tooltip_window: 
            self.tooltip_window.destroy()
            self.tooltip_window = None

class VODGroupRow(ctk.CTkFrame):
    def __init__(self, parent, title, date_str, cancel_command=None, theme_colors=None):
        bg_card = theme_colors["bg_card"] if theme_colors else "#212121"
        b_width = theme_colors.get("border_width", 0) if theme_colors else 0
        b_color = theme_colors.get("border_color", bg_card) if theme_colors else bg_card
        
        super().__init__(parent, fg_color="transparent")
        self.pack(fill="x", pady=4)
        self.expanded = False
        
        # Header Frame mit Border
        self.header_frame = ctk.CTkFrame(self, fg_color=bg_card, height=45, corner_radius=6, border_width=b_width, border_color=b_color)
        self.header_frame.pack(fill="x")
        self.header_frame.grid_columnconfigure(1, weight=1)

        self.lbl_date = ctk.CTkLabel(self.header_frame, text=date_str, text_color="#E5A00D", font=ctk.CTkFont(size=13, weight="bold"))
        self.lbl_date.grid(row=0, column=0, padx=(15, 10), pady=10)
        
        disp_title = title if len(title) < 40 else title[:40] + "..."
        self.lbl_title = ctk.CTkLabel(self.header_frame, text=disp_title, anchor="w", font=ctk.CTkFont(size=13))
        self.lbl_title.grid(row=0, column=1, sticky="ew", pady=10)
        CTkToolTip(self.lbl_title, title)
        
        self.actions_frame = ctk.CTkFrame(self.header_frame, fg_color="transparent")
        self.actions_frame.grid(row=0, column=2, padx=5, pady=5)

        self.btn_toggle = ctk.CTkButton(self.actions_frame, text="▼", width=35, height=30, fg_color="#333333", hover_color="#444444", font=ctk.CTkFont(size=12), command=self.toggle)
        self.btn_toggle.pack(side="left", padx=(0, 5))

        if cancel_command:
            self.btn_stop = ctk.CTkButton(self.actions_frame, text="⏹", width=35, height=30, fg_color="#C0392B", hover_color="#922B21", command=cancel_command)
            self.btn_stop.pack(side="left")
            CTkToolTip(self.btn_stop, "Diesen Download abbrechen")

        self.content_frame = ctk.CTkFrame(self, fg_color="transparent")

    def toggle(self):
        if self.expanded:
            self.content_frame.pack_forget()
            self.btn_toggle.configure(text="▼")
            self.expanded = False
        else:
            self.content_frame.pack(fill="x", padx=10, pady=(5, 5))
            self.btn_toggle.configure(text="▲")
            self.expanded = True
            
    def show_remove_button(self):
        if hasattr(self, 'btn_stop'): self.btn_stop.destroy()
        self.btn_remove = ctk.CTkButton(self.actions_frame, text="✖", width=35, height=30, fg_color="#C0392B", hover_color="#922B21", command=self.destroy)
        self.btn_remove.pack(side="left") 
        CTkToolTip(self.btn_remove, "Eintrag entfernen")

# ==========================================
# MAIN APP CLASS
# ==========================================
class TwitchDownloaderApp(ctk.CTk):
    def __init__(self):
        super().__init__()
        self.config = self.load_config()
        self.geometry("1920x1080")
        self.minsize(1280, 720)
        
        current_streamer = self.config.get('streamer_name', '')
        self.title(f"Twitch VOD Manager [{APP_VERSION}]" + (f" - {current_streamer}" if current_streamer else ""))
        self.protocol("WM_DELETE_WINDOW", self.on_closing)

        # Variablen
        self.token = None
        self.download_queue = []
        self.is_downloading = False
        self.current_process = None
        self.current_download_cancelled = False
        self.active_tab = "search"

        # Performance: Connection Pooling & Thread Pool
        self.session = requests.Session()
        adapter = requests.adapters.HTTPAdapter(pool_connections=5, pool_maxsize=10, max_retries=3)
        self.session.mount('https://', adapter)
        self.thumbnail_executor = ThreadPoolExecutor(max_workers=MAX_THUMBNAIL_WORKERS, thread_name_prefix="thumb_")

        # Theme Cache
        self._cached_theme: Optional[Dict[str, Any]] = None
        self._cached_theme_name: str = ""

        # Cutter
        self.video_cap = None
        self.video_total_frames = 0
        self.video_fps = 0
        self.cut_start_sec = 0
        self.cut_end_sec = 0
        self.last_cut_folder = ""

        # UI SETUP
        self.grid_columnconfigure(1, weight=1)
        self.grid_rowconfigure(0, weight=1)

        # Sidebar
        self.frame_left = ctk.CTkFrame(self, width=320, corner_radius=0)
        self.frame_left.grid(row=0, column=0, sticky="nsew")
        self.frame_left.grid_rowconfigure(5, weight=1)  # Queue Container
        self.frame_left.grid_rowconfigure(6, weight=2)  # Downloads Container (größer)

        self.lbl_logo = ctk.CTkLabel(self.frame_left, text=self._get_greeting(), font=ctk.CTkFont(size=22, weight="bold"))
        self.lbl_logo.grid(row=0, column=0, padx=20, pady=(30, 20))

        self.btn_tab_search = ctk.CTkButton(self.frame_left, text="  📺   Twitch VODs", height=40, font=ctk.CTkFont(size=14), anchor="w", border_width=0, command=lambda: self.show_frame("search"))
        self.btn_tab_search.grid(row=1, column=0, padx=20, pady=10, sticky="ew")

        self.btn_tab_clips = ctk.CTkButton(self.frame_left, text="  🎬   Twitch Clips", height=40, font=ctk.CTkFont(size=14), anchor="w", border_width=0, command=lambda: self.show_frame("clips"))
        self.btn_tab_clips.grid(row=2, column=0, padx=20, pady=(0, 10), sticky="ew")

        self.btn_tab_cutter = ctk.CTkButton(self.frame_left, text="  ✂    Cutter / Splitter", height=40, font=ctk.CTkFont(size=14), anchor="w", border_width=0, command=lambda: self.show_frame("cutter"))
        self.btn_tab_cutter.grid(row=3, column=0, padx=20, pady=(0, 10), sticky="ew")

        self.btn_tab_settings = ctk.CTkButton(self.frame_left, text="  ⚙️   Einstellungen", height=40, font=ctk.CTkFont(size=14), anchor="w", border_width=0, command=lambda: self.show_frame("settings"))
        self.btn_tab_settings.grid(row=4, column=0, padx=20, pady=(0, 30), sticky="ew")

        # Warteschlange Container mit Border
        self.frame_queue_container = ctk.CTkFrame(self.frame_left, border_width=1)
        self.frame_queue_container.grid(row=5, column=0, padx=10, pady=(10, 5), sticky="nsew")
        self.lbl_queue_title = ctk.CTkLabel(self.frame_queue_container, text="Warteschlange (0):", anchor="w", font=ctk.CTkFont(weight="bold"))
        self.lbl_queue_title.pack(padx=10, pady=(8, 0), anchor="w")
        self.scroll_queue = ctk.CTkScrollableFrame(self.frame_queue_container, height=120, fg_color="transparent")
        self.scroll_queue.pack(padx=5, pady=5, fill="both", expand=True)

        # Aktive Downloads Container mit Border
        self.frame_downloads_container = ctk.CTkFrame(self.frame_left, border_width=1)
        self.frame_downloads_container.grid(row=6, column=0, padx=10, pady=5, sticky="nsew")
        self.lbl_downloads_title = ctk.CTkLabel(self.frame_downloads_container, text="Aktive Downloads & Status:", anchor="w", font=ctk.CTkFont(weight="bold"))
        self.lbl_downloads_title.pack(padx=10, pady=(8, 0), anchor="w")
        self.scroll_downloads = ctk.CTkScrollableFrame(self.frame_downloads_container, height=220, fg_color="transparent")
        self.scroll_downloads.pack(padx=5, pady=5, fill="both", expand=True)

        self.frame_actions = ctk.CTkFrame(self.frame_left, fg_color="transparent")
        self.frame_actions.grid(row=7, column=0, padx=20, pady=20, sticky="ew")
        
        self.btn_start = ctk.CTkButton(self.frame_actions, text="▶ Start", fg_color="green", hover_color="darkgreen", height=40, font=ctk.CTkFont(size=14, weight="bold"), command=self.start_download_thread)
        self.btn_start.pack(side="left", fill="x", expand=True, padx=(0, 5))

        self.btn_clear = ctk.CTkButton(self.frame_actions, text="🗑 Leeren", fg_color="gray30", hover_color="gray40", height=40, command=self.clear_finished_downloads)
        self.btn_clear.pack(side="right", fill="x", expand=True, padx=(5, 0))

        # Main Area
        self.frame_right = ctk.CTkFrame(self, corner_radius=0, fg_color="transparent")
        self.frame_right.grid(row=0, column=1, sticky="nsew")
        self.frame_right.grid_columnconfigure(0, weight=1)
        self.frame_right.grid_rowconfigure(0, weight=1) 
        self.frame_right.grid_rowconfigure(1, weight=0)

        self.frame_content = ctk.CTkFrame(self.frame_right, fg_color="transparent")
        self.frame_content.grid(row=0, column=0, sticky="nsew", padx=20, pady=20)
        self.frame_content.grid_columnconfigure(0, weight=1)
        self.frame_content.grid_rowconfigure(0, weight=1)

        self.frame_log = ctk.CTkFrame(self.frame_right, height=150, corner_radius=10)
        self.frame_log.grid(row=1, column=0, sticky="ew", padx=20, pady=(0, 20))
        
        ctk.CTkLabel(self.frame_log, text="System Protokoll", font=ctk.CTkFont(size=12, weight="bold")).pack(anchor="w", padx=10, pady=(5,0))
        self.textbox_log = ctk.CTkTextbox(self.frame_log, height=120, font=("Consolas", 11))
        self.textbox_log.pack(fill="both", padx=10, pady=5)
        self.textbox_log.configure(state="disabled")

        self.frames = {}
        self.frames["search"] = self.create_search_frame(self.frame_content)
        self.frames["settings"] = self.create_settings_frame(self.frame_content)
        self.frames["cutter"] = self.create_cutter_frame(self.frame_content)
        self.frames["clips"] = self.create_clips_frame(self.frame_content)

        # Clip Counter für Dateinamen
        self.clip_counter = 1

        # INIT THEME
        self.apply_theme(self.config.get("theme", "Default"))
        self.show_frame("search")
        
        if self.config["client_id"] and self.config["client_secret"]:
            threading.Thread(target=self.perform_login, daemon=True).start()
        else:
            self.show_frame("settings")

        # Gespeicherte Queue wiederherstellen
        self.after(100, self.load_queue_state)

        # Update-Check beim Start
        self.after(2000, self.check_for_updates_on_startup)

    def on_closing(self) -> None:
        if self.is_downloading:
            if not messagebox.askokcancel("Beenden?", "Download läuft! Wirklich abbrechen?"):
                return

        # Queue speichern falls gewünscht
        self.save_queue_state()
        self.save_settings(silent=True)

        # Ressourcen freigeben
        if self.video_cap:
            self.video_cap.release()

        if self.current_process:
            try:
                self.current_process.kill()
            except (OSError, ProcessLookupError):
                pass

        # Thread Pool herunterfahren
        if hasattr(self, 'thumbnail_executor'):
            self.thumbnail_executor.shutdown(wait=False)

        # Session schließen
        if hasattr(self, 'session'):
            self.session.close()

        self.destroy()
        sys.exit()

    def apply_theme(self, theme_name):
        if theme_name not in THEMES:
            theme_name = "Default"
        self.current_theme_name = theme_name
        colors = THEMES[theme_name]
        self.config["theme"] = theme_name

        # UI Style Parameter
        corner_radius = colors.get("corner_radius", 8)
        btn_radius = colors.get("button_corner_radius", 8)
        font_family = colors.get("font_family", "Segoe UI")
        font_title = colors.get("font_size_title", 22)
        font_normal = colors.get("font_size_normal", 14)
        font_small = colors.get("font_size_small", 12)

        # Hintergrund-Farben
        self.configure(fg_color=colors["bg_main"])
        self.frame_left.configure(fg_color=colors["bg_sidebar"])
        btn_border_width = colors.get("button_border_width", 0)
        btn_border_color = colors.get("button_border_color", "transparent")

        # Queue & Downloads Container mit Border
        self.frame_queue_container.configure(fg_color=colors["bg_card"], corner_radius=corner_radius, border_width=btn_border_width, border_color=btn_border_color)
        self.frame_downloads_container.configure(fg_color=colors["bg_card"], corner_radius=corner_radius, border_width=btn_border_width, border_color=btn_border_color)
        self.lbl_downloads_title.configure(text_color=colors["text"], font=ctk.CTkFont(family=font_family, size=font_small, weight="bold"))
        self.frame_right.configure(fg_color=colors["bg_main"])
        self.frame_log.configure(fg_color=colors["bg_card"], corner_radius=corner_radius)
        self.textbox_log.configure(fg_color=colors["bg_main"], text_color=colors["text"], corner_radius=corner_radius)

        # Logo
        self.lbl_logo.configure(text_color=colors["text"], font=ctk.CTkFont(family=font_family, size=font_title, weight="bold"))

        # Tab Buttons Style
        self.update_tab_buttons(colors)

        # Start/Clear Buttons
        self.btn_start.configure(corner_radius=btn_radius, font=ctk.CTkFont(family=font_family, size=font_normal, weight="bold"))
        self.btn_clear.configure(corner_radius=btn_radius, font=ctk.CTkFont(family=font_family, size=font_normal))

        # Queue Title
        self.lbl_queue_title.configure(text_color=colors["text"], font=ctk.CTkFont(family=font_family, size=font_small, weight="bold"))

    def update_tab_buttons(self, colors):
        btn_radius = colors.get("button_corner_radius", 8)
        font_family = colors.get("font_family", "Segoe UI")
        font_normal = colors.get("font_size_normal", 14)
        btn_border_width = colors.get("button_border_width", 0)
        btn_border_color = colors.get("button_border_color", "transparent")

        for btn in [self.btn_tab_search, self.btn_tab_cutter, self.btn_tab_clips, self.btn_tab_settings]:
            btn.configure(
                fg_color="transparent",
                text_color=colors["text"],
                hover_color=colors["bg_card"],
                corner_radius=btn_radius,
                border_width=btn_border_width,
                border_color=btn_border_color,
                font=ctk.CTkFont(family=font_family, size=font_normal)
            )
        active_btn = None
        if self.active_tab == "search": active_btn = self.btn_tab_search
        elif self.active_tab == "cutter": active_btn = self.btn_tab_cutter
        elif self.active_tab == "clips": active_btn = self.btn_tab_clips
        elif self.active_tab == "settings": active_btn = self.btn_tab_settings
        if active_btn:
            active_btn.configure(fg_color=colors["accent"], text_color=colors["tab_text_active"], hover_color=colors["accent_hover"])

    def show_frame(self, name: str) -> None:
        self.active_tab = name
        for frame in self.frames.values():
            frame.grid_forget()
        self.frames[name].grid(row=0, column=0, sticky="nsew")
        self.update_tab_buttons(THEMES[self.current_theme_name])

    # ==========================================
    # HELPER METHODS
    # ==========================================
    def get_theme_colors(self) -> Dict[str, Any]:
        """Cached Theme-Colors abrufen."""
        if self._cached_theme is None or self._cached_theme_name != self.current_theme_name:
            self._cached_theme = THEMES[self.current_theme_name].copy()
            self._cached_theme_name = self.current_theme_name
        return self._cached_theme

    def get_themed_frame_config(self) -> Dict[str, Any]:
        """Frame-Konfiguration mit Theme-Borders."""
        colors = self.get_theme_colors()
        b_width = colors.get("border_width", 0)
        b_color = colors.get("border_color", colors["bg_card"])
        if b_color == "transparent" and b_width > 0:
            b_color = "#333333"
        return {"fg_color": colors["bg_card"], "border_width": b_width, "border_color": b_color}

    def format_eta(self, bytes_remaining: float, speed_bps: float) -> str:
        """Geschaetzte Restzeit formatieren."""
        if speed_bps <= 0:
            return "berechne..."
        eta_sec = bytes_remaining / speed_bps
        return self.format_seconds(eta_sec)

    # ==========================================
    # QUEUE PERSISTENCE
    # ==========================================
    def save_queue_state(self) -> None:
        """Queue-Status in Datei speichern."""
        queue_data = []
        for item in self.download_queue:
            if item.get('is_merge_job'):
                continue  # Merge-Jobs nicht speichern
            try:
                queue_data.append({
                    'title': item['title'],
                    'url': item['url'],
                    'date': item['date'].isoformat() if hasattr(item['date'], 'isoformat') else str(item['date']),
                    'streamer': item['streamer'],
                    'duration_str': item['duration_str'],
                    'custom_clip': item.get('custom_clip')
                })
            except (KeyError, AttributeError):
                continue
        try:
            with open(QUEUE_FILE, 'w', encoding='utf-8') as f:
                json.dump(queue_data, f, indent=2)
        except IOError as e:
            self.log(f"Queue speichern fehlgeschlagen: {e}")

    def load_queue_state(self) -> None:
        """Queue-Status aus Datei laden."""
        if not os.path.exists(QUEUE_FILE):
            return
        try:
            with open(QUEUE_FILE, 'r', encoding='utf-8') as f:
                queue_data = json.load(f)
            for item in queue_data:
                try:
                    dt = datetime.datetime.fromisoformat(item['date'])
                    self.add_to_queue(
                        item['title'],
                        item['url'],
                        dt,
                        item['streamer'],
                        item['duration_str'],
                        item.get('custom_clip')
                    )
                except (KeyError, ValueError) as e:
                    self.log(f"Queue-Item konnte nicht geladen werden: {e}")
            # Datei nach erfolgreichem Laden löschen
            try:
                os.remove(QUEUE_FILE)
            except OSError:
                pass  # Ignorieren wenn Löschen fehlschlägt
            if queue_data:
                self.log(f"{len(queue_data)} Queue-Items wiederhergestellt.")
        except (IOError, json.JSONDecodeError) as e:
            self.log(f"Queue laden fehlgeschlagen: {e}")

    # ==========================================
    # RETRY MECHANISM
    # ==========================================
    def run_streamlink_with_retry(self, cmd: List[str], filename: str, label: str,
                                   duration_sec: int, parent_group, attempt: int = 1) -> bool:
        """Streamlink mit Retry-Mechanismus ausfuehren."""
        success = self.run_streamlink_process_with_cmd(cmd, filename, label, duration_sec, parent_group)
        if success:
            return True

        if attempt < MAX_RETRY_ATTEMPTS and not self.current_download_cancelled:
            delay = RETRY_DELAY_SECONDS * attempt
            self.log(f"Retry {attempt}/{MAX_RETRY_ATTEMPTS} für {label} in {delay}s...")
            time.sleep(delay)
            return self.run_streamlink_with_retry(cmd, filename, label, duration_sec, parent_group, attempt + 1)

        return False

    def create_settings_frame(self, parent):
        frame = ctk.CTkScrollableFrame(parent, fg_color="transparent")
        card_theme = ctk.CTkFrame(frame)
        card_theme.pack(fill="x", pady=10, padx=10)
        ctk.CTkLabel(card_theme, text="🎨 Design & Theme", font=("Arial", 16, "bold")).pack(anchor="w", padx=15, pady=(15, 5))
        self.var_theme = ctk.StringVar(value=self.config.get("theme", "Default"))
        self.opt_theme = ctk.CTkOptionMenu(card_theme, values=list(THEMES.keys()), variable=self.var_theme, command=self.apply_theme)
        self.opt_theme.pack(anchor="w", padx=15, pady=(0, 15))
        
        card_api = ctk.CTkFrame(frame)
        card_api.pack(fill="x", pady=10, padx=10)
        ctk.CTkLabel(card_api, text="🔑 API Zugang", font=("Arial", 16, "bold")).pack(anchor="w", padx=15, pady=(15, 5))
        ctk.CTkLabel(card_api, text="Client ID:").pack(anchor="w", padx=15)
        self.entry_client_id = ctk.CTkEntry(card_api)
        self.entry_client_id.insert(0, self.config["client_id"])
        self.entry_client_id.pack(fill="x", padx=15, pady=(0, 10))
        self.entry_client_id.bind("<FocusOut>", lambda e: self.save_settings())
        ctk.CTkLabel(card_api, text="Client Secret:").pack(anchor="w", padx=15)
        self.entry_client_secret = ctk.CTkEntry(card_api, show="*")
        self.entry_client_secret.insert(0, self.config["client_secret"])
        self.entry_client_secret.pack(fill="x", padx=15, pady=(0, 15))
        self.entry_client_secret.bind("<FocusOut>", lambda e: self.save_settings())
        
        card_storage = ctk.CTkFrame(frame)
        card_storage.pack(fill="x", pady=10, padx=10)
        ctk.CTkLabel(card_storage, text="📁 Speicherort", font=("Arial", 16, "bold")).pack(anchor="w", padx=15, pady=(15, 5))
        path_box = ctk.CTkFrame(card_storage, fg_color="transparent")
        path_box.pack(fill="x", padx=15, pady=(0, 15))
        self.entry_path = ctk.CTkEntry(path_box)
        self.entry_path.insert(0, self.config["download_path"])
        self.entry_path.pack(side="left", fill="x", expand=True, padx=(0, 10))
        self.entry_path.bind("<FocusOut>", lambda e: self.save_settings())
        ctk.CTkButton(path_box, text="📂", width=45, command=self.browse_folder).pack(side="right", padx=(5, 0))
        ctk.CTkButton(path_box, text="↗", width=45, fg_color="#34495E", hover_color="#2E4053", command=self.open_save_folder).pack(side="right")
        
        card_yt = ctk.CTkFrame(frame)
        card_yt.pack(fill="x", pady=10, padx=10)
        yt_header = ctk.CTkFrame(card_yt, fg_color="transparent")
        yt_header.pack(anchor="w", padx=15, pady=(15, 5))
        ctk.CTkLabel(yt_header, text="📺 YouTube Auto-Upload", font=("Arial", 16, "bold")).pack(side="left")
        ctk.CTkLabel(yt_header, text="(Coming Soon)", font=("Arial", 12), text_color="gray").pack(side="left", padx=(10, 0))

        self.chk_upload_val = ctk.BooleanVar(value=False)
        self.chk_upload = ctk.CTkCheckBox(card_yt, text="Automatisch hochladen", variable=self.chk_upload_val, state="disabled", text_color_disabled="gray")
        self.chk_upload.pack(anchor="w", padx=15, pady=(0, 10))
        ctk.CTkLabel(card_yt, text="Firefox Profil Pfad:", text_color="gray").pack(anchor="w", padx=15)
        self.entry_profile_path = ctk.CTkEntry(card_yt, state="disabled", fg_color="gray25")
        self.entry_profile_path.pack(fill="x", padx=15, pady=(0, 15))
        
        card_opts = ctk.CTkFrame(frame)
        card_opts.pack(fill="x", pady=10, padx=10)
        ctk.CTkLabel(card_opts, text="⚙️ Download Optionen", font=("Arial", 16, "bold")).pack(anchor="w", padx=15, pady=(15, 5))
        self.seg_mode = ctk.CTkSegmentedButton(card_opts, values=["Parts (Gesplittet)", "Full (Ganzes VOD)"], command=lambda e: self.save_settings())
        self.seg_mode.set("Parts (Gesplittet)" if self.config.get("download_mode") == "parts" else "Full (Ganzes VOD)")
        self.seg_mode.pack(fill="x", padx=15, pady=(0, 10))
        ctk.CTkLabel(card_opts, text="Part Länge (Minuten):").pack(anchor="w", padx=15)
        minutes_frame = ctk.CTkFrame(card_opts, fg_color="transparent")
        minutes_frame.pack(anchor="w", padx=15, pady=(0, 15))
        self.entry_minutes = ctk.CTkEntry(minutes_frame, width=100)
        self.entry_minutes.insert(0, str(self.config.get("part_minutes", 120)))
        self.entry_minutes.pack(side="left")
        ctk.CTkButton(minutes_frame, text="Speichern", width=80, command=self.save_part_minutes).pack(side="left", padx=(10, 0))

        # Update Card
        card_update = ctk.CTkFrame(frame)
        card_update.pack(fill="x", pady=10, padx=10)
        ctk.CTkLabel(card_update, text="🔄 Updates", font=("Arial", 16, "bold")).pack(anchor="w", padx=15, pady=(15, 5))
        update_frame = ctk.CTkFrame(card_update, fg_color="transparent")
        update_frame.pack(fill="x", padx=15, pady=(0, 15))
        self.lbl_version = ctk.CTkLabel(update_frame, text=f"Aktuelle Version: {APP_VERSION}")
        self.lbl_version.pack(anchor="w")
        self.lbl_update_status = ctk.CTkLabel(update_frame, text="", text_color="gray")
        self.lbl_update_status.pack(anchor="w", pady=(5, 0))
        btn_frame = ctk.CTkFrame(update_frame, fg_color="transparent")
        btn_frame.pack(anchor="w", pady=(10, 0))
        self.btn_check_update = ctk.CTkButton(btn_frame, text="Nach Updates suchen", width=160, command=self.check_for_updates)
        self.btn_check_update.pack(side="left")
        self.btn_download_update = ctk.CTkButton(btn_frame, text="Update installieren", width=140, fg_color="green", hover_color="darkgreen", command=self.download_and_install_update, state="disabled")
        self.btn_download_update.pack(side="left", padx=(10, 0))

        return frame

    def create_cutter_frame(self, parent):
        frame = ctk.CTkFrame(parent, fg_color="transparent")
        content = ctk.CTkFrame(frame, fg_color="transparent")
        content.pack(fill="both", expand=True, padx=20, pady=20)
        ctk.CTkLabel(content, text="Video Cutter (Timeline)", font=ctk.CTkFont(size=22, weight="bold")).pack(pady=10)
        file_frame = ctk.CTkFrame(content, fg_color="transparent")
        file_frame.pack(fill="x", padx=20, pady=5)
        self.entry_cut_file = ctk.CTkEntry(file_frame, placeholder_text="Pfad zur .mp4 Datei")
        self.entry_cut_file.pack(side="left", fill="x", expand=True, padx=(0, 10))
        ctk.CTkButton(file_frame, text="📂", width=50, command=self.browse_video_file).pack(side="right")
        self.lbl_file_info = ctk.CTkLabel(content, text="", text_color="gray")
        self.lbl_file_info.pack(pady=(0, 10))
        self.editor_area = ctk.CTkFrame(content, fg_color="gray15")
        self.editor_area.pack(fill="both", expand=True, padx=20, pady=10)
        self.lbl_preview = ctk.CTkLabel(self.editor_area, text="[Vorschau]", width=480, height=270, fg_color="black")
        self.lbl_preview.pack(pady=10)
        self.timeline = VideoTimeline(self.editor_area, width=600, height=40, bg="#212121", command=self.on_timeline_change)
        self.timeline.pack(fill="x", padx=20, pady=10)
        ctrl_frame = ctk.CTkFrame(self.editor_area, fg_color="transparent")
        ctrl_frame.pack(fill="x", pady=10)
        box_in = ctk.CTkFrame(ctrl_frame, fg_color="transparent")
        box_in.pack(side="left", padx=40)
        ctk.CTkLabel(box_in, text="Start:", font=("Arial", 12, "bold"), text_color="gray").pack()
        self.entry_time_in = ctk.CTkEntry(box_in, width=100, font=("Consolas", 14), justify="center")
        self.entry_time_in.pack()
        self.entry_time_in.bind("<Return>", lambda e: self.manual_time_update())
        box_out = ctk.CTkFrame(ctrl_frame, fg_color="transparent")
        box_out.pack(side="right", padx=40)
        ctk.CTkLabel(box_out, text="Ende:", font=("Arial", 12, "bold"), text_color="gray").pack()
        self.entry_time_out = ctk.CTkEntry(box_out, width=100, font=("Consolas", 14), justify="center")
        self.entry_time_out.pack()
        self.entry_time_out.bind("<Return>", lambda e: self.manual_time_update())
        self.btn_cut_action = ctk.CTkButton(content, text="✂ Ausschnitt erstellen", height=45, font=ctk.CTkFont(size=16), fg_color="green", hover_color="darkgreen", command=self.start_cut_thread)
        self.btn_cut_action.pack(pady=(15, 5))
        self.btn_open_cut_folder = ctk.CTkButton(content, text="📂 Ordner öffnen", width=150, fg_color="#34495E", hover_color="#2E4053", command=self.open_cut_folder)
        self.progress_cut = ctk.CTkProgressBar(content, height=12, width=400)
        self.progress_cut.set(0)
        self.progress_cut.pack(pady=(5, 5))
        self.progress_cut.pack_forget()
        self.lbl_cut_status = ctk.CTkLabel(content, text="", font=ctk.CTkFont(size=14))
        self.lbl_cut_status.pack(pady=(5, 15))
        return frame

    def create_clips_frame(self, parent):
        frame = ctk.CTkFrame(parent, fg_color="transparent")
        content = ctk.CTkFrame(frame, fg_color="transparent")
        content.pack(fill="both", expand=True, padx=20, pady=20)

        ctk.CTkLabel(content, text="Twitch Clip Downloader", font=ctk.CTkFont(size=22, weight="bold")).pack(pady=(10, 20))

        # URL Eingabe
        url_frame = ctk.CTkFrame(content, fg_color="transparent")
        url_frame.pack(fill="x", padx=20, pady=10)
        ctk.CTkLabel(url_frame, text="Clip URL:", font=ctk.CTkFont(size=14)).pack(anchor="w")
        self.entry_clip_url = ctk.CTkEntry(url_frame, placeholder_text="https://clips.twitch.tv/... oder https://www.twitch.tv/.../clip/...", height=40)
        self.entry_clip_url.pack(fill="x", pady=(5, 10))

        # Download Button
        self.btn_download_clip = ctk.CTkButton(
            content, text="⬇  Clip herunterladen", height=40,
            font=ctk.CTkFont(family="Segoe UI", size=14, weight="bold"), fg_color="green", hover_color="darkgreen",
            command=self.download_clip
        )
        self.btn_download_clip.pack(pady=15)

        # Status
        self.lbl_clip_status = ctk.CTkLabel(content, text="", font=ctk.CTkFont(size=14))
        self.lbl_clip_status.pack(pady=10)

        # Progress
        self.progress_clip = ctk.CTkProgressBar(content, height=12, width=400)
        self.progress_clip.set(0)
        self.progress_clip.pack(pady=5)
        self.progress_clip.pack_forget()

        # Info Box
        info_frame = ctk.CTkFrame(content)
        info_frame.pack(fill="x", padx=20, pady=20)
        ctk.CTkLabel(info_frame, text="ℹ️ Info", font=ctk.CTkFont(size=14, weight="bold")).pack(anchor="w", padx=15, pady=(10, 5))
        ctk.CTkLabel(
            info_frame,
            text="Unterstützte Formate:\n• https://clips.twitch.tv/ClipName\n• https://www.twitch.tv/streamer/clip/ClipName\n\nDateien werden gespeichert als:\nStreamer_Datum_Clip_0001_ClipName.mp4",
            justify="left", text_color="gray"
        ).pack(anchor="w", padx=15, pady=(0, 15))

        return frame

    def download_clip(self) -> None:
        """Twitch Clip herunterladen."""
        url = self.entry_clip_url.get().strip()
        if not url:
            self.lbl_clip_status.configure(text="Bitte Clip-URL eingeben!", text_color="red")
            return

        if not self.token:
            self.lbl_clip_status.configure(text="Nicht eingeloggt! Bitte API-Daten in Einstellungen eingeben.", text_color="red")
            return

        # UI aktualisieren
        self.btn_download_clip.configure(state="disabled", text="Lade...")
        self.lbl_clip_status.configure(text="Hole Clip-Informationen...", text_color="yellow")
        self.progress_clip.pack(pady=5)
        self.progress_clip.set(0)

        threading.Thread(target=self._download_clip_thread, args=(url,), daemon=True).start()

    def _download_clip_thread(self, url: str) -> None:
        """Clip-Download in separatem Thread."""
        try:
            # Clip-ID aus URL extrahieren
            clip_id = self._extract_clip_id(url)
            if not clip_id:
                self.after(0, lambda: self.lbl_clip_status.configure(text="Ungültige Clip-URL!", text_color="red"))
                self.after(0, lambda: self.btn_download_clip.configure(state="normal", text="⬇  Clip herunterladen"))
                return

            # Clip-Info von API holen
            headers = {'Client-ID': self.config["client_id"], 'Authorization': f'Bearer {self.token}'}
            resp = self.session.get(
                'https://api.twitch.tv/helix/clips',
                params={'id': clip_id},
                headers=headers,
                timeout=API_TIMEOUT
            )

            try:
                json_data = resp.json()
            except json.JSONDecodeError:
                self.after(0, lambda: self.lbl_clip_status.configure(text="Ungültige API-Antwort!", text_color="red"))
                self.after(0, lambda: self.btn_download_clip.configure(state="normal", text="⬇  Clip herunterladen"))
                return

            if resp.status_code != 200 or not json_data.get('data'):
                self.after(0, lambda: self.lbl_clip_status.configure(text="Clip nicht gefunden!", text_color="red"))
                self.after(0, lambda: self.btn_download_clip.configure(state="normal", text="⬇  Clip herunterladen"))
                return

            clip_data = json_data['data'][0]
            broadcaster_name = clip_data['broadcaster_name']
            clip_title = clip_data['title']
            created_at = clip_data['created_at']
            thumbnail_url = clip_data['thumbnail_url']

            # Datum formatieren
            try:
                dt = datetime.datetime.strptime(created_at, "%Y-%m-%dT%H:%M:%SZ")
                date_str = dt.strftime("%Y-%m-%d")
            except:
                date_str = datetime.datetime.now().strftime("%Y-%m-%d")

            # Clip-Titel bereinigen (keine Sonderzeichen im Dateinamen)
            safe_title = "".join(c for c in clip_title if c.isalnum() or c in " -_").strip()[:50]

            # Dateiname erstellen
            filename = f"{broadcaster_name}_{date_str}_Clip_{self.clip_counter:04d}_{safe_title}.mp4"
            self.clip_counter += 1

            # Speicherpfad - Twitch_Clips Ordner im Verzeichnis der Python-Datei
            script_dir = os.path.dirname(os.path.abspath(__file__))
            save_path = os.path.join(script_dir, "Twitch_Clips", broadcaster_name)
            os.makedirs(save_path, exist_ok=True)
            filepath = os.path.join(save_path, filename)

            self.after(0, lambda ct=clip_title: self.lbl_clip_status.configure(text=f"Lade: {ct[:40]}...", text_color="yellow"))

            # Clip-URL für Streamlink erstellen
            clip_url = f"https://clips.twitch.tv/{clip_id}"

            # Streamlink für Download verwenden
            cmd = [
                *get_streamlink_cmd(),
                clip_url,
                "best",
                "-o", filepath,
                "--force"
            ]

            process = subprocess.Popen(
                cmd,
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
                creationflags=CREATE_NO_WINDOW if os.name == 'nt' else 0
            )
            self.current_process = process  # Speichern für Cleanup bei App-Close

            try:
                stdout, stderr = process.communicate(timeout=120)
            except subprocess.TimeoutExpired:
                process.kill()
                process.communicate()  # Clean up
                self.after(0, lambda: self.lbl_clip_status.configure(text="Timeout beim Download!", text_color="red"))
                self.log("Clip-Download Timeout (120s)")
                return

            if process.returncode != 0:
                error_msg = stderr.decode('utf-8', errors='ignore') if stderr else "Unbekannter Fehler"
                self.after(0, lambda: self.lbl_clip_status.configure(text="Download fehlgeschlagen!", text_color="red"))
                self.log(f"Streamlink Fehler: {error_msg}")
                self.after(0, lambda: self.progress_clip.pack_forget())
                return

            # Prüfen ob Datei existiert und größer als 1KB ist
            if os.path.exists(filepath) and os.path.getsize(filepath) > 1024:
                self.after(0, lambda: self.progress_clip.set(1.0))
                self.after(0, lambda fn=filename: self.lbl_clip_status.configure(text=f"Gespeichert: {fn}", text_color="green"))
                self.log(f"Clip heruntergeladen: {filename}")
            else:
                self.after(0, lambda: self.lbl_clip_status.configure(text="Download fehlgeschlagen!", text_color="red"))
                if os.path.exists(filepath):
                    os.remove(filepath)

        except Exception as e:
            self.after(0, lambda err=e: self.lbl_clip_status.configure(text=f"Fehler: {err}", text_color="red"))
            self.log(f"Clip-Download Fehler: {e}")

        finally:
            self.after(0, lambda: self.btn_download_clip.configure(state="normal", text="⬇  Clip herunterladen"))
            self.after(0, lambda: self.progress_clip.pack_forget())

    def _get_greeting(self) -> str:
        """Zeitabhängige Begrüßung zurückgeben."""
        hour = datetime.datetime.now().hour
        if 5 <= hour < 12:
            return "Guten Morgen..."
        elif 12 <= hour < 18:
            return "Guten Tag..."
        else:
            return "Guten Abend..."

    def _extract_clip_id(self, url: str) -> Optional[str]:
        """Clip-ID aus verschiedenen URL-Formaten extrahieren."""
        # Format: https://clips.twitch.tv/ClipName
        match = re.search(r'clips\.twitch\.tv/([A-Za-z0-9_-]+)', url)
        if match:
            return match.group(1)

        # Format: https://www.twitch.tv/streamer/clip/ClipName
        match = re.search(r'twitch\.tv/[^/]+/clip/([A-Za-z0-9_-]+)', url)
        if match:
            return match.group(1)

        return None

    def open_cut_folder(self):
        if self.last_cut_folder and os.path.exists(self.last_cut_folder):
            try: 
                os.startfile(self.last_cut_folder)
            except: 
                pass
    
    def browse_video_file(self):
        f = filedialog.askopenfilename(filetypes=[("Video files", "*.mp4 *.mkv *.ts *.mov")])
        if f: 
            self.entry_cut_file.delete(0, "end")
            self.entry_cut_file.insert(0, f)
            threading.Thread(target=self.load_video_data, args=(f,), daemon=True).start()

    def load_video_data(self, filepath):
        try:
            self.after(0, lambda: self.lbl_cut_status.configure(text="Lade Video...", text_color="yellow"))
            if self.video_cap:
                self.video_cap.release()
            try:
                self.video_cap = cv2.VideoCapture(filepath)
            except:
                self.after(0, lambda: self.lbl_cut_status.configure(text="OpenCV Error", text_color="red"))
                return
            if not self.video_cap.isOpened():
                raise Exception("Datei nicht lesbar")
            self.video_total_frames = int(self.video_cap.get(cv2.CAP_PROP_FRAME_COUNT))
            if self.video_total_frames <= 0:
                raise Exception("Video-Frames nicht lesbar")
            self.video_fps = self.video_cap.get(cv2.CAP_PROP_FPS)
            if self.video_fps <= 0:
                self.video_fps = 30.0  # Fallback FPS
            duration_sec = self.video_total_frames / self.video_fps
            self.cut_start_sec = 0
            self.cut_end_sec = duration_sec
            self.after(0, lambda: self.timeline.set_values(0.0, 1.0))
            self.after(0, lambda ds=duration_sec: self.lbl_file_info.configure(text=f"Länge: {self.format_seconds(ds)}"))
            self.after(0, lambda: self.lbl_cut_status.configure(text="Bereit.", text_color="green"))
            self.after(0, lambda: self.update_preview(0))
            self.after(0, lambda: self.update_cut_labels())
        except Exception as e:
            self.after(0, lambda err=e: self.lbl_cut_status.configure(text=f"Fehler: {err}", text_color="red"))

    def on_timeline_change(self, start_ratio, end_ratio, handle_moved):
        if not self.video_cap or self.video_total_frames == 0 or self.video_fps <= 0:
            return
        total_sec = self.video_total_frames / self.video_fps
        self.cut_start_sec = start_ratio * total_sec
        self.cut_end_sec = end_ratio * total_sec
        self.update_cut_labels()
        target_sec = self.cut_start_sec if handle_moved == 'start' else self.cut_end_sec
        self.update_preview(int(target_sec * self.video_fps))

    def manual_time_update(self):
        if not self.video_cap or self.video_total_frames == 0 or self.video_fps <= 0: return
        try:
            s_parts = list(map(int, self.entry_time_in.get().split(':')))
            if len(s_parts) != 3: raise ValueError("Ungültiges Format")
            s_sec = s_parts[0]*3600 + s_parts[1]*60 + s_parts[2]
            e_parts = list(map(int, self.entry_time_out.get().split(':')))
            if len(e_parts) != 3: raise ValueError("Ungültiges Format")
            e_sec = e_parts[0]*3600 + e_parts[1]*60 + e_parts[2]
            total_sec = self.video_total_frames / self.video_fps
            s_sec = max(0, min(s_sec, total_sec))
            e_sec = max(0, min(e_sec, total_sec))
            if s_sec >= e_sec: s_sec = e_sec - 1
            self.cut_start_sec = s_sec
            self.cut_end_sec = e_sec
            self.timeline.set_values(s_sec / total_sec, e_sec / total_sec)
            self.update_cut_labels()
            self.update_preview(int(s_sec * self.video_fps))
        except: 
            self.lbl_cut_status.configure(text="Format Fehler (HH:MM:SS)", text_color="red")

    def update_cut_labels(self):
        self.entry_time_in.delete(0, "end")
        self.entry_time_in.insert(0, self.format_seconds(self.cut_start_sec))
        self.entry_time_out.delete(0, "end")
        self.entry_time_out.insert(0, self.format_seconds(self.cut_end_sec))

    def update_preview(self, frame_no):
        if not self.video_cap: return
        self.video_cap.set(cv2.CAP_PROP_POS_FRAMES, frame_no)
        ret, frame = self.video_cap.read()
        if ret:
            frame = cv2.cvtColor(frame, cv2.COLOR_BGR2RGB)
            img = Image.fromarray(frame)
            img.thumbnail((480, 270))
            ctk_img = ctk.CTkImage(light_image=img, dark_image=img, size=img.size)
            self.lbl_preview.configure(image=ctk_img, text="")
            self.video_preview_image = ctk_img

    def format_seconds(self, seconds: float) -> str:
        """Sekunden in HH:MM:SS Format umwandeln."""
        m, s = divmod(int(seconds), 60)
        h, m = divmod(m, 60)
        return f"{h:02d}:{m:02d}:{s:02d}"

    def start_cut_thread(self):
        if not self.entry_cut_file.get().strip():
            self.lbl_cut_status.configure(text="Bitte Datei auswählen!", text_color="red")
            return
        if not os.path.exists(self.entry_cut_file.get()):
            self.lbl_cut_status.configure(text="Datei nicht gefunden!", text_color="red")
            return
        if self.cut_end_sec <= self.cut_start_sec:
            self.lbl_cut_status.configure(text="Ende muss nach Start sein!", text_color="red")
            return
        self.btn_open_cut_folder.pack_forget()
        self.btn_cut_action.configure(state="disabled", text="Initialisiere...", fg_color="gray40")
        self.progress_cut.pack(pady=(5, 5))
        self.progress_cut.set(0)
        self.lbl_cut_status.configure(text="Starte FFmpeg...", text_color="yellow")
        start_str = self.format_seconds(self.cut_start_sec)
        end_str = self.format_seconds(self.cut_end_sec)
        threading.Thread(target=self.run_ffmpeg_cut, args=(self.entry_cut_file.get(), start_str, end_str), daemon=True).start()

    def run_ffmpeg_cut(self, input_file, start, end):
        try:
            self.last_cut_folder = os.path.dirname(input_file)
            out = os.path.join(self.last_cut_folder, f"{os.path.splitext(os.path.basename(input_file))[0]}_cut_{datetime.datetime.now().strftime('%H%M%S')}.mp4")
            total_duration_sec = self.cut_end_sec - self.cut_start_sec
            if total_duration_sec <= 0: total_duration_sec = 1 
            total_duration_us = total_duration_sec * 1_000_000
            cmd = [imageio_ffmpeg.get_ffmpeg_exe(), "-i", input_file, "-ss", start, "-to", end, "-c", "copy", "-progress", "pipe:1", "-y", out]
            creation_flags = CREATE_NO_WINDOW if os.name == 'nt' else 0
            process = subprocess.Popen(cmd, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, creationflags=creation_flags, universal_newlines=True)
            self.current_process = process  # Speichern für Cleanup bei App-Close
            while True:
                line = process.stdout.readline()
                if not line:
                    if process.poll() is not None: break
                    continue
                if "out_time_us=" in line:
                    try:
                        current_us = int(line.strip().split("=")[1])
                        percent = min(1.0, current_us / total_duration_us)
                        self.after(0, lambda p=percent, d=int(percent*100): (self.progress_cut.set(p), self.btn_cut_action.configure(text=f"Schneide... {d}%")))
                    except: pass
            if process.poll() == 0:
                out_basename = os.path.basename(out)
                self.after(0, lambda ob=out_basename: self.lbl_cut_status.configure(text=f"Fertig: {ob}", text_color="green"))
                self.after(0, lambda: self.progress_cut.set(1.0))
                self.after(0, lambda: self.btn_open_cut_folder.pack(before=self.lbl_cut_status, pady=5))
            else:
                self.after(0, lambda: self.lbl_cut_status.configure(text="Fehler beim Schneiden (FFmpeg)", text_color="red"))
                self.after(0, lambda: self.progress_cut.pack_forget())
        except Exception as e:
            self.after(0, lambda err=e: self.lbl_cut_status.configure(text=f"Fehler: {err}", text_color="red"))
            self.after(0, lambda: self.progress_cut.pack_forget())
        self.after(0, lambda: self.btn_cut_action.configure(state="normal", text="✂ Ausschnitt erstellen", fg_color="green"))

    # ==========================================
    # DOWNLOAD & UPLOAD
    # ==========================================
    def open_merge_dialog(self, source_item):
        if len(self.download_queue) < 2:
            messagebox.showinfo("Merge Info", "Du brauchst mindestens 2 Videos in der Queue.")
            return

        dialog = tk.Toplevel(self)
        dialog.title("Merge Auswahl")
        dialog.geometry("600x400")
        dialog.configure(bg="#2b2b2b")
        dialog.grab_set()

        tk.Label(dialog, text=f"Basis (#1): {source_item['title'][:30]}...", fg="#E5A00D", bg="#2b2b2b", font=("Arial", 11, "bold")).pack(pady=10)
        tk.Label(dialog, text="Wähle weitere Teile in der gewünschten Reihenfolge:", fg="white", bg="#2b2b2b").pack()

        scroll_frame = ctk.CTkScrollableFrame(dialog, height=200, bg_color="#2b2b2b", fg_color="#212121")
        scroll_frame.pack(fill="both", expand=True, padx=10, pady=5)

        possible_items = [x for x in self.download_queue if x['ui_widget'] != source_item['ui_widget'] and 'is_merge_job' not in x]
        
        selection_order = [] 
        item_rows = []

        def update_numbers():
            for idx, (item, lbl) in enumerate(item_rows):
                if item in selection_order:
                    pos = selection_order.index(item) + 2
                    lbl.configure(text=f"#{pos}", text_color="#E5A00D")
                else:
                    lbl.configure(text="", text_color="gray")

        def on_toggle(item, var):
            if var.get():
                if item not in selection_order:
                    selection_order.append(item)
            else:
                if item in selection_order:
                    selection_order.remove(item)
            update_numbers()

        if not possible_items:
            ctk.CTkLabel(scroll_frame, text="Keine weiteren Videos verfügbar.", text_color="gray").pack(pady=20)

        for item in possible_items:
            row = ctk.CTkFrame(scroll_frame, fg_color="transparent")
            row.pack(fill="x", pady=2)
            
            lbl_num = ctk.CTkLabel(row, text="", width=30, font=("Arial", 12, "bold"))
            lbl_num.pack(side="left", padx=5)
            item_rows.append((item, lbl_num))
            
            var = ctk.BooleanVar()
            chk = ctk.CTkCheckBox(row, text=item['title'], variable=var, command=lambda i=item, v=var: on_toggle(i, v))
            chk.pack(side="left", fill="x", expand=True)

        def confirm(mode):
            if not selection_order:
                messagebox.showwarning("Fehler", "Bitte mindestens ein weiteres Video wählen!")
                return
            
            self.create_merge_job(source_item, selection_order, mode)
            dialog.destroy()

        btn_box = tk.Frame(dialog, bg="#2b2b2b")
        btn_box.pack(fill="x", pady=15)
        
        ctk.CTkButton(btn_box, text="Verbinden & Splitten", fg_color="green", width=180, command=lambda: confirm("split")).pack(side="left", padx=10)
        ctk.CTkButton(btn_box, text="Nur Verbinden (Full)", fg_color="#D35400", width=180, command=lambda: confirm("full")).pack(side="right", padx=10)

    def create_merge_job(self, source_item, other_items, merge_mode):
        all_items = [source_item] + other_items
        total_dur = sum([self.parse_duration_string(i['duration_str']) for i in all_items])
        
        for item in all_items:
            if item.get('ui_widget'): 
                item['ui_widget'].destroy()
            if item in self.download_queue: 
                self.download_queue.remove(item)

        m, s = divmod(total_dur, 60)
        h, m = divmod(m, 60)
        dur_str = f"{h}h{m}m{s}s"
        combined_title = f"MERGE ({merge_mode.upper()}): {source_item['title'][:15]}... + {len(other_items)} Parts"

        colors = THEMES[self.current_theme_name]
        b_width = colors.get("border_width", 0)
        b_color = colors.get("border_color", "transparent")
        
        if b_color == "transparent" and b_width > 0: 
            b_color = "#333333"

        f = ctk.CTkFrame(self.scroll_queue, fg_color=colors["bg_card"], height=40, border_width=b_width, border_color=b_color)
        f.pack(fill="x", pady=2, padx=2)
        ctk.CTkButton(f, text="✖", width=30, height=25, fg_color="#C0392B", hover_color="#922B21", command=lambda: self.remove_from_queue("", f)).pack(side="right", padx=5, pady=5)
        ctk.CTkLabel(f, text="[JOB]", width=40, font=ctk.CTkFont(size=12, weight="bold"), text_color="#2ECC71").pack(side="left", padx=5)
        l = ctk.CTkLabel(f, text=combined_title, anchor="w", font=ctk.CTkFont(size=12))
        l.pack(side="left", fill="x", expand=True, padx=5)
        
        merge_item = {
            'title': combined_title,
            'streamer': source_item['streamer'],
            'date': datetime.datetime.now(),
            'duration_str': dur_str,
            'ui_widget': f,
            'is_merge_job': True,
            'merge_mode': merge_mode, 
            'sub_items': all_items
        }
        self.download_queue.append(merge_item)
        self.lbl_queue_title.configure(text=f"Warteschlange ({len(self.download_queue)}):")

    def start_download_thread(self):
        if not self.download_queue or self.is_downloading: return
        self.is_downloading = True
        self.btn_start.configure(state="normal", text="⏹ Abbrechen", fg_color="#C0392B", hover_color="#922B21", command=self.cancel_download)
        self.btn_clear.configure(state="disabled") 
        threading.Thread(target=self.process_queue, daemon=True).start()

    def cancel_download(self):
        self.is_downloading = False
        self.log("Download wird abgebrochen...")
        if self.current_process:
            try: self.current_process.kill()
            except: pass

    def process_queue(self):
        global_mode = self.config.get("download_mode", "parts")
        base_path = self.config["download_path"]
        mins = self.config.get("part_minutes", 120)
        part_seconds = mins * 60
        do_upload = self.config.get("upload_to_youtube", False)
        profile_path = self.config.get("firefox_profile_path", "")
        self.log(f"--- START QUEUE ---")
        
        for i, item in enumerate(self.download_queue, 1):
            if not self.is_downloading: break 
            self.current_download_cancelled = False
            
            raw_streamer = item.get('streamer', 'Unbekannt')
            streamer_name_clean = "".join([c for c in raw_streamer if c.isalpha() or c.isdigit() or c in " .-_"]).strip()
            d_str = item['date'].strftime("%d.%m.%Y")
            folder = os.path.join(base_path, streamer_name_clean, d_str)
            try: os.makedirs(folder, exist_ok=True)
            except Exception as e:
                self.log(f"Fehler Ordner: {e}"); self.after(0, self.finish_download_process); return
            
            video_title = item['title']
            
            def cancel_this_vod():
                self.log(f"Abbruch: {video_title}")
                self.current_download_cancelled = True
                if self.current_process:
                    try: self.current_process.kill()
                    except: pass

            vod_group = VODGroupRow(self.scroll_downloads, video_title, d_str, cancel_command=cancel_this_vod, theme_colors=THEMES[self.current_theme_name])
            files_downloaded = [] 

            # --- MERGE JOB LOGIC ---
            if item.get('is_merge_job', False):
                self.log(f"Verarbeite Merge-Job: {video_title}")
                temp_files = []
                merge_failed = False
                job_merge_mode = item.get('merge_mode', 'split') # 'split' or 'full'
                
                for idx, sub in enumerate(item['sub_items']):
                    if not self.is_downloading or self.current_download_cancelled: break
                    
                    sub_fname = os.path.join(folder, f"TEMP_MERGE_{idx}.mp4")
                    
                    # --- SMART MERGE: Check if sub-item is a custom clip ---
                    if 'custom_clip' in sub:
                        c_data = sub['custom_clip']
                        dur_sec = c_data['duration_sec']
                        cmd = [*get_streamlink_cmd(), sub['url'], "best", 
                               "--hls-start-offset", f"{c_data['start_sec']}s", 
                               "--hls-duration", f"{dur_sec}s", 
                               "-o", sub_fname, "--force"]
                        success = self.run_streamlink_process_with_cmd(cmd, sub_fname, f"DL Part {idx+1} (Cut)", dur_sec, vod_group)
                    else:
                        dur_sec = self.parse_duration_string(sub.get('duration_str', '4h'))
                        success = self.run_streamlink_process(sub['url'], sub_fname, f"DL Part {idx+1} (Full)", dur_sec, vod_group)
                    
                    if success: temp_files.append(sub_fname)
                    else: merge_failed = True; break
                
                if not merge_failed and not self.current_download_cancelled and len(temp_files) > 0:
                    merged_filename = os.path.join(folder, f"{d_str}_MERGED_FULL.mp4")
                    list_txt = os.path.join(folder, "concat_list.txt")
                    try:
                        with open(list_txt, "w", encoding="utf-8") as f:
                            for tf in temp_files: f.write(f"file '{tf}'\n")
                    except IOError as e:
                        self.log(f"Fehler beim Schreiben der concat_list: {e}")
                        merge_failed = True

                    if not merge_failed:
                        use_split = (job_merge_mode == 'split')

                        # Berechne Totalzeit für Progress (berücksichtige custom_clips)
                        def get_item_duration(s):
                            if 'custom_clip' in s:
                                return s['custom_clip'].get('duration_sec', 60)
                            return self.parse_duration_string(s.get('duration_str', ''))
                        total_time_estimate = sum([get_item_duration(s) for s in item['sub_items']])

                        concat_success = self.run_ffmpeg_concat_and_split(
                            list_txt, merged_filename, vod_group, use_split, part_seconds, folder, d_str, video_title, files_downloaded, total_time_estimate
                        )

                        try:
                            os.remove(list_txt)
                            for tf in temp_files: os.remove(tf)
                        except: pass
            
            # --- CUSTOM CLIP LOGIC ---
            elif 'custom_clip' in item:
                clip_data = item['custom_clip']
                clip_start_sec = clip_data['start_sec']
                clip_duration = clip_data['duration_sec']
                start_part = clip_data.get('start_part', 1)
                filename_format = clip_data.get('filename_format', 'simple')

                def make_filename(part_num, start_offset):
                    if filename_format == 'timestamp':
                        time_str = time.strftime('%H-%M-%S', time.gmtime(clip_start_sec + start_offset))
                        return os.path.join(folder, f"{d_str}_CLIP_{time_str}_Part{part_num}.mp4")
                    else:
                        return os.path.join(folder, f"{d_str}_Part{part_num}.mp4")

                # Wenn Clip länger als part_seconds, in Parts aufteilen
                if clip_duration > part_seconds:
                    part = start_part
                    curr_offset = 0
                    while curr_offset < clip_duration:
                        if not self.is_downloading or self.current_download_cancelled:
                            break
                        remaining = clip_duration - curr_offset
                        this_part_duration = min(part_seconds, remaining)

                        filename = make_filename(part, curr_offset)
                        actual_start = clip_start_sec + curr_offset

                        cmd = [*get_streamlink_cmd(), item['url'], "best",
                               "--hls-start-offset", f"{actual_start}s",
                               "--hls-duration", f"{this_part_duration}s",
                               "-o", filename, "--force"]

                        success = self.run_streamlink_process_with_cmd(cmd, filename, f"Part {part}", this_part_duration, vod_group)
                        if success:
                            files_downloaded.append((filename, f"{video_title} - Part {part}"))
                        else:
                            break

                        curr_offset += part_seconds
                        part += 1
                else:
                    # Kurzer Clip - als einzelne Datei mit Part-Nummer
                    filename = make_filename(start_part, 0)
                    cmd = [*get_streamlink_cmd(), item['url'], "best",
                           "--hls-start-offset", f"{clip_start_sec}s",
                           "--hls-duration", f"{clip_duration}s",
                           "-o", filename, "--force"]

                    success = self.run_streamlink_process_with_cmd(cmd, filename, f"Part {start_part}", clip_duration, vod_group)
                    if success:
                        files_downloaded.append((filename, f"{video_title} - Part {start_part}"))

            # --- NORMAL JOB LOGIC ---
            else:
                if global_mode == "full":
                    filename = os.path.join(folder, f"{d_str}_Full.mp4")
                    est_sec = self.parse_duration_string(item.get('duration_str', '4h')) 
                    success = self.run_streamlink_process(item['url'], filename, "Full VOD", est_sec, vod_group)
                    if success: files_downloaded.append((filename, f"{video_title} - Full"))
                else:
                    part = 1
                    curr_time = 0
                    
                    # FIX: Ermitteln der Gesamtdauer
                    total_video_seconds = self.parse_duration_string(item.get('duration_str', '4h'))
                    
                    while True:
                        if not self.is_downloading: break
                        if self.current_download_cancelled: break
                        
                        # Sicherstellen, dass wir nicht übers Ziel hinausschießen
                        if curr_time >= total_video_seconds + 600: 
                             self.log(f"  > Gesamtdauer erreicht. Beende Parts.")
                             break
                        
                        filename = os.path.join(folder, f"{d_str}_Part{part}.mp4")
                        cmd = [*get_streamlink_cmd(), item['url'], "best", "--hls-start-offset", f"{curr_time}s", "--hls-duration", f"{part_seconds}s", "-o", filename, "--force"]
                        
                        success = self.run_streamlink_process_with_cmd(cmd, filename, f"Part {part}", part_seconds, vod_group)
                        
                        if success: 
                            files_downloaded.append((filename, f"{video_title} - Part {part}"))
                            # FIX: Check auf korrupte/winzige Datei um Infinite Loop zu verhindern
                            try:
                                if os.path.exists(filename):
                                    f_size_mb = os.path.getsize(filename) / (1024 * 1024)
                                    # Wenn die Datei kleiner als 15MB ist UND wir erwarten eigentlich noch mehr Video
                                    # Dann ist Streamlink wahrscheinlich abgebrochen oder Video ist zu Ende
                                    if f_size_mb < 15 and (curr_time + part_seconds) < total_video_seconds:
                                        self.log(f"  > Part {part} zu klein ({f_size_mb:.2f}MB). Wahrscheinlich VOD-Ende erreicht. Stoppe Loop.")
                                        break
                            except: pass

                        if self.current_download_cancelled: break
                        
                        if not success: 
                            break # Wenn Streamlink schon sagt "Fehler", Loop beenden
                            
                        curr_time += part_seconds; part += 1
            
            # --- UPLOAD ---
            if do_upload and files_downloaded and not self.current_download_cancelled:
                self.log(f"Starte YouTube Uploads für '{video_title}'...")
                for f_path, f_title in files_downloaded:
                    if not self.is_downloading: break
                    ui_refs = self.add_download_ui_row(f"UPLOAD: {f_title}", vod_group.content_frame)
                    ui_refs['lbl_status'].configure(text="Bereite vor...", text_color="#E5A00D")
                    self.perform_direct_selenium_upload(f_path, f_title, ui_refs, profile_path)
            
            self.after(0, vod_group.show_remove_button)
            self.after(0, lambda w=item.get('ui_widget'): w.destroy() if w else None)
            self.after(0, lambda r=len(self.download_queue) - i: self.lbl_queue_title.configure(text=f"Warteschlange ({r}):"))

        self.after(0, self.finish_download_process)

    def monitor_ffmpeg_progress(self, process, ui_refs, total_duration_us):
        # Liest output line-by-line für Progress Bar
        while True:
            line = process.stdout.readline()
            if not line:
                if process.poll() is not None: break
                continue
            
            if "out_time_us=" in line:
                try:
                    current_us = int(line.strip().split("=")[1])
                    if total_duration_us > 0:
                        percent = min(1.0, current_us / total_duration_us)
                        self.after(0, lambda p=percent: ui_refs['progress'].set(p))
                except: pass

    def run_ffmpeg_concat_and_split(self, list_file, output_file, vod_group, do_split, part_seconds, folder, d_str, vid_title, files_list, total_dur_sec):
        # 1. CONCAT
        ui_refs = self.add_download_ui_row("Verbinde Videos (FFmpeg)...", vod_group.content_frame)
        
        # -progress pipe:1 sorgt dafür, dass wir Statusupdates bekommen
        cmd = [imageio_ffmpeg.get_ffmpeg_exe(), "-f", "concat", "-safe", "0", "-i", list_file, "-c", "copy", "-progress", "pipe:1", "-y", output_file]
        
        try:
            self.current_process = subprocess.Popen(cmd, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, creationflags=CREATE_NO_WINDOW if os.name == 'nt' else 0, universal_newlines=True)
            
            # Start Monitor Thread
            total_dur_us = total_dur_sec * 1_000_000
            t = threading.Thread(target=self.monitor_ffmpeg_progress, args=(self.current_process, ui_refs, total_dur_us), daemon=True)
            t.start()

            while self.current_process.poll() is None:
                if not self.is_downloading or self.current_download_cancelled:
                    self.current_process.kill()
                    self.update_download_ui_status(ui_refs, "Abgebrochen", "red")
                    return False
                time.sleep(0.5)
            
            t.join() # Warte auf Thread

            if os.path.exists(output_file) and self.current_process.returncode == 0:
                self.update_download_ui_status(ui_refs, "Verbunden", "green")
                self.mark_row_finished(ui_refs)
                
                if not do_split:
                    files_list.append((output_file, f"{vid_title} - Merged Full"))
                    return True
                else:
                    return self.run_ffmpeg_local_split(output_file, part_seconds, folder, d_str, vid_title, vod_group, files_list, total_dur_us)
            else:
                self.update_download_ui_status(ui_refs, "Fehler (Merge)", "red")
                self.mark_row_finished(ui_refs)
                return False
        except Exception as e:
            self.log(f"Merge Error: {e}")
            self.update_download_ui_status(ui_refs, "Error", "red")
            self.mark_row_finished(ui_refs)
            return False

    def run_ffmpeg_local_split(self, input_file, segment_time, folder, d_str, vid_title, vod_group, files_list, total_dur_us):
        ui_refs = self.add_download_ui_row("Splitte Video (FFmpeg)...", vod_group.content_frame)
        
        # New pattern: Datum_Part1.mp4, Datum_Part2.mp4
        pattern = os.path.join(folder, f"{d_str}_Part%d.mp4")
        
        cmd = [
            imageio_ffmpeg.get_ffmpeg_exe(), "-i", input_file, "-c", "copy", "-map", "0",
            "-f", "segment", "-segment_time", str(segment_time), 
            "-segment_start_number", "1", # Start bei 1
            "-reset_timestamps", "1", 
            "-progress", "pipe:1",
            "-y", pattern
        ]
        
        try:
            self.current_process = subprocess.Popen(cmd, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, creationflags=CREATE_NO_WINDOW if os.name == 'nt' else 0, universal_newlines=True)
            
            t = threading.Thread(target=self.monitor_ffmpeg_progress, args=(self.current_process, ui_refs, total_dur_us), daemon=True)
            t.start()

            while self.current_process.poll() is None:
                if not self.is_downloading or self.current_download_cancelled:
                    self.current_process.kill()
                    self.update_download_ui_status(ui_refs, "Abgebrochen", "red")
                    return False
                time.sleep(0.5)

            t.join()

            if self.current_process.returncode == 0:
                # Find generated files
                generated = [f for f in os.listdir(folder) if f.startswith(f"{d_str}_") and f.endswith(".mp4") and "_Full" not in f and "MERGED" not in f]
                generated.sort()
                
                self.update_download_ui_status(ui_refs, f"Fertig ({len(generated)} Parts)", "green")
                self.mark_row_finished(ui_refs)
                
                for g in generated:
                    full_p = os.path.join(folder, g)
                    files_list.append((full_p, f"{vid_title} - {g}"))
                
                # Delete large source file
                try: os.remove(input_file)
                except: pass
                
                return True
            else:
                self.update_download_ui_status(ui_refs, "Fehler (Split)", "red")
                self.mark_row_finished(ui_refs)
                return False

        except Exception as e:
            self.log(f"Split Error: {e}")
            self.update_download_ui_status(ui_refs, "Error", "red")
            self.mark_row_finished(ui_refs)
            return False

    def perform_direct_selenium_upload(self, filepath, title, ui_refs, profile_path):
        if not os.path.exists(filepath):
            self.after(0, lambda: self.update_download_ui_status(ui_refs, "Datei fehlt", "red"))
            self.after(0, lambda: self.mark_row_finished(ui_refs))
            return
        driver = None
        try:
            self.after(0, lambda: self.update_download_ui_status(ui_refs, "Öffne Firefox...", "yellow"))
            service = Service("geckodriver.exe"); options = Options()
            options.add_argument("--disable-blink-features=AutomationControlled")
            if profile_path and os.path.exists(profile_path): options.add_argument("-profile"); options.add_argument(profile_path)
            local_app_data = os.getenv('LOCALAPPDATA', '')
            possible_binaries = [r"C:\Program Files\Mozilla Firefox\firefox.exe", r"C:\Program Files (x86)\Mozilla Firefox\firefox.exe"]
            if local_app_data:
                possible_binaries.append(os.path.join(local_app_data, r"Mozilla Firefox\firefox.exe"))
            for p in possible_binaries:
                if os.path.exists(p): options.binary_location = p; break
            driver = webdriver.Firefox(service=service, options=options)
            driver.get("https://studio.youtube.com")
            self.after(0, lambda: self.update_download_ui_status(ui_refs, "Warte auf Login...", "yellow"))
            max_login_wait = 180; waited = 0
            while "studio.youtube.com" not in driver.current_url:
                time.sleep(1); waited += 1
                if not self.is_downloading:
                    self.after(0, lambda: self.update_download_ui_status(ui_refs, "Abgebrochen", "red"))
                    self.after(0, lambda: self.mark_row_finished(ui_refs))
                    driver.quit()
                    return
                if waited > max_login_wait:
                    self.after(0, lambda: self.update_download_ui_status(ui_refs, "Timeout Login", "red"))
                    self.after(0, lambda: self.mark_row_finished(ui_refs))
                    driver.quit()
                    return
            self.after(0, lambda: self.update_download_ui_status(ui_refs, "Starte Upload...", "yellow"))
            driver.get("https://www.youtube.com/upload"); time.sleep(2)
            driver.find_element(By.XPATH, "//input[@type='file']").send_keys(os.path.abspath(filepath))
            self.after(0, lambda: self.update_download_ui_status(ui_refs, "Lade hoch (Warte auf 100%)...", "yellow"))
            wait_counter = 0; upload_finished = False
            while True:
                if not self.is_downloading: break
                try:
                    body_text = driver.find_element(By.TAG_NAME, "body").text
                    if "Verarbeitung" in body_text or "Processing" in body_text or "Upload abgeschlossen" in body_text or "Upload complete" in body_text or "Überprüfung" in body_text or "Checks" in body_text:
                        self.log("Upload Status: Fertig erkannt. Schließe Browser in 5s..."); time.sleep(5); upload_finished = True; break
                    time.sleep(2); wait_counter += 2
                    if wait_counter > 7200: self.log("Timeout beim Upload (2h). Breche ab."); break
                except: time.sleep(2)
            if upload_finished:
                self.after(0, lambda: self.update_download_ui_status(ui_refs, "Fertig (Draft)", "green"))
            else:
                self.after(0, lambda: self.update_download_ui_status(ui_refs, "Abbruch/Fehler", "red"))
            self.after(0, lambda: self.mark_row_finished(ui_refs))
            driver.quit()
        except Exception as e:
            self.log(f"Selenium Error: {e}")
            self.after(0, lambda: self.update_download_ui_status(ui_refs, "Fehler (Browser)", "red"))
            self.after(0, lambda: self.mark_row_finished(ui_refs))
            if driver:
                try: driver.quit()
                except: pass

    def run_streamlink_process(self, url: str, filename: str, label: str,
                                duration_sec: int, parent_group) -> bool:
        return self.run_streamlink_process_with_cmd(
            [*get_streamlink_cmd(), url, "best", "-o", filename, "--force"],
            filename, label, duration_sec, parent_group
        )

    def run_streamlink_process_with_cmd(self, cmd: List[str], filename: str, label: str,
                                         duration_sec: int, parent_group) -> bool:
        ui_refs = self.add_download_ui_row(label, parent_group.content_frame)
        # Mindestens 60 Sekunden annehmen um Division durch 0 zu vermeiden
        safe_duration = max(60, duration_sec)
        target_size_bytes = safe_duration * ESTIMATED_BYTES_PER_SEC
        try:
            self.current_process = subprocess.Popen(
                cmd, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
                creationflags=CREATE_NO_WINDOW if os.name == 'nt' else 0
            )
            last_check_time = time.time()
            last_size = 0
            while self.current_process.poll() is None:
                if not self.is_downloading:
                    self.current_process.kill()
                    return False
                if self.current_download_cancelled:
                    self.current_process.kill()
                    self.after(0, lambda: self.update_download_ui_status(ui_refs, "Abgebrochen", "red"))
                    self.after(0, lambda: self.mark_row_finished(ui_refs))
                    time.sleep(0.5)
                    if os.path.exists(filename):
                        try:
                            os.remove(filename)
                        except OSError:
                            pass
                    return False
                if os.path.exists(filename):
                    current_size = os.path.getsize(filename)
                    current_time = time.time()
                    elapsed = current_time - last_check_time
                    if elapsed >= 1.0:
                        speed = (current_size - last_size) / elapsed
                        speed_str = f"{self.format_bytes(speed)}/s"
                        size_str = self.format_bytes(current_size)
                        percent = min(100, int((current_size / target_size_bytes) * 100))
                        if percent >= 100:
                            percent = 99
                        # ETA berechnen
                        bytes_remaining = max(0, target_size_bytes - current_size)
                        eta_str = self.format_eta(bytes_remaining, speed)
                        self.after(0, lambda p=percent/100, s=size_str, sp=speed_str, eta=eta_str: (
                            ui_refs['progress'].set(p),
                            ui_refs['lbl_status'].configure(text=f"{s} | {sp} | ETA: {eta}")
                        ))
                        last_size = current_size
                        last_check_time = current_time
                time.sleep(0.5)
            self.current_process = None
            if self.current_download_cancelled:
                self.after(0, lambda: self.update_download_ui_status(ui_refs, "Abgebrochen", "red"))
                if os.path.exists(filename):
                    try: os.remove(filename) 
                    except: pass
                return False
            if os.path.exists(filename):
                size = os.path.getsize(filename)
                # Checke hier ob größer als 1 MB ist. Für den Loop Fix mache ich im Process Queue Loop noch einen genaueren Check.
                if size < 1024 * 1024:
                    self.after(0, lambda: self.update_download_ui_status(ui_refs, "Fehler (zu klein)", "gray"))
                    self.after(0, lambda: self.mark_row_finished(ui_refs))
                    try: os.remove(filename)
                    except: pass
                    return False
                else:
                    self.after(0, lambda s=size: (ui_refs['progress'].set(1.0), ui_refs['progress'].configure(progress_color="green"), ui_refs['lbl_status'].configure(text=f"Fertig ({self.format_bytes(s)})", text_color="green")))
                    self.log(f"  > '{label}' fertig."); self.after(0, lambda: self.mark_row_finished(ui_refs)); return True
            else:
                self.after(0, lambda: self.update_download_ui_status(ui_refs, "Fehler: Datei fehlt", "red"))
                self.after(0, lambda: self.mark_row_finished(ui_refs)); return False
        except Exception as e:
            self.log(f"Error: {e}"); self.after(0, lambda: self.update_download_ui_status(ui_refs, "Absturz", "red")); self.after(0, lambda: self.mark_row_finished(ui_refs)); return False

    def add_download_ui_row(self, label_text, parent_widget):
        colors = THEMES[self.current_theme_name]
        b_width = colors.get("border_width", 0)
        b_color = colors.get("border_color", "transparent")
        
        if b_color == "transparent" and b_width > 0: b_color = "#333333"

        card = ctk.CTkFrame(parent_widget, fg_color=colors.get("bg_card", "gray25"), height=70, border_width=b_width, border_color=b_color)
        card.pack(fill="x", pady=2, padx=5)
        card.is_finished = False
        header_frame = ctk.CTkFrame(card, fg_color="transparent")
        header_frame.pack(side="top", fill="x", padx=10, pady=(5, 0))
        lbl_title = ctk.CTkLabel(header_frame, text=label_text, anchor="w", font=ctk.CTkFont(size=12))
        lbl_title.pack(side="left", fill="x", expand=True)
        progress = ctk.CTkProgressBar(card, height=8)
        progress.set(0)
        progress.pack(side="top", fill="x", padx=10, pady=(8, 0))
        lbl_status = ctk.CTkLabel(card, text="Starte...", anchor="e", font=ctk.CTkFont(size=11), text_color="gray")
        lbl_status.pack(side="top", fill="x", padx=10, pady=(2, 5))
        return {'frame': card, 'progress': progress, 'lbl_status': lbl_status, 'header_frame': header_frame}

    def mark_row_finished(self, ui_refs):
        def do_mark():
            ui_refs['frame'].is_finished = True
            btn_del = ctk.CTkButton(ui_refs['header_frame'], text="✖", width=25, height=20, fg_color="#C0392B", hover_color="#922B21", font=ctk.CTkFont(size=10, weight="bold"), command=lambda: ui_refs['frame'].destroy())
            btn_del.pack(side="right", padx=0)
        # Thread-safe: UI-Updates immer über after()
        self.after(0, do_mark)

    def clear_finished_downloads(self):
        for group in self.scroll_downloads.winfo_children():
            if isinstance(group, VODGroupRow):
                for row in list(group.content_frame.winfo_children()):
                    marked_finished = getattr(row, 'is_finished', False)
                    is_status_done = False
                    try:
                        for child in row.winfo_children():
                            if isinstance(child, ctk.CTkLabel):
                                text = child.cget("text"); color = child.cget("text_color")
                                if color in ["green", "red"] or "Abgebrochen" in text or "Fertig" in text: is_status_done = True
                    except: pass
                    if marked_finished or is_status_done: row.destroy()
        for group in list(self.scroll_downloads.winfo_children()):
            if isinstance(group, VODGroupRow):
                if not group.content_frame.winfo_children(): group.destroy()

    def update_download_ui_status(self, ui_refs, text, color):
        def do_update():
            ui_refs['lbl_status'].configure(text=text, text_color=color)
            if color == "green": ui_refs['progress'].configure(progress_color="green")
            elif color == "red": ui_refs['progress'].configure(progress_color="red")
            else: ui_refs['progress'].configure(progress_color="gray")
        # Thread-safe: UI-Updates immer über after()
        self.after(0, do_update)

    def format_bytes(self, size: float) -> str:
        """Bytes in lesbare Groesse umwandeln (KB, MB, GB, TB)."""
        if size < 0:
            size = 0
        power = 1024
        n = 0
        power_labels = {0: '', 1: 'K', 2: 'M', 3: 'G', 4: 'T'}
        while size > power and n < 4:
            size /= power
            n += 1
        return f"{size:.2f} {power_labels[n]}B"

    def parse_duration_string(self, dur_str: str) -> int:
        """Duration-String (z.B. '2h30m15s') in Sekunden umwandeln."""
        seconds = 0
        try:
            temp = dur_str.strip()
            if not temp:
                return 3600
            if 'h' in temp:
                parts = temp.split('h')
                h_val = parts[0].strip()
                seconds += int(h_val) * 3600 if h_val else 0
                temp = parts[1] if len(parts) > 1 else ""
            if 'm' in temp:
                parts = temp.split('m')
                m_val = parts[0].strip()
                seconds += int(m_val) * 60 if m_val else 0
                temp = parts[1] if len(parts) > 1 else ""
            if 's' in temp:
                parts = temp.split('s')
                s_val = parts[0].strip()
                seconds += int(s_val) if s_val else 0
        except (ValueError, IndexError):
            return 3600 * 4
        return seconds if seconds > 0 else 3600

    def finish_download_process(self):
        self.is_downloading = False
        self.download_queue.clear()
        self.lbl_queue_title.configure(text="Warteschlange (0):")
        self.btn_start.configure(state="normal", text="▶ Start", fg_color="green", hover_color="darkgreen", command=self.start_download_thread)
        self.btn_clear.configure(state="normal")

    def create_search_frame(self, parent):
        frame = ctk.CTkFrame(parent, fg_color="transparent")
        frame.grid_columnconfigure(0, weight=1); frame.grid_rowconfigure(2, weight=1)
        top_bar = ctk.CTkFrame(frame, fg_color="transparent")
        top_bar.grid(row=0, column=0, padx=20, pady=20, sticky="ew")
        
        self.entry_search_streamer = ctk.CTkEntry(top_bar, placeholder_text="Streamer Name", width=250, height=35)
        self.entry_search_streamer.pack(side="left", padx=(0, 10)); self.entry_search_streamer.insert(0, self.config.get("streamer_name", ""))
        
        self.combo_filter = ctk.CTkOptionMenu(top_bar, values=["Frühere Übertragungen", "Highlights"], width=170, height=35)
        self.combo_filter.pack(side="left", padx=(0, 10))

        self.btn_load_vods = ctk.CTkButton(top_bar, text="Suchen", width=120, height=35, command=self.on_load_vods)
        self.btn_load_vods.pack(side="left")
        
        self.lbl_status = ctk.CTkLabel(top_bar, text="", text_color="yellow")
        self.lbl_status.pack(side="left", padx=15)
        
        header = ctk.CTkLabel(frame, text="Ergebnisse:", font=ctk.CTkFont(size=16, weight="bold"))
        header.grid(row=1, column=0, padx=20, pady=(0, 10), sticky="w")
        self.scroll_results = ctk.CTkScrollableFrame(frame, label_text="Suchergebnisse")
        self.scroll_results.grid(row=2, column=0, padx=20, pady=(0, 20), sticky="nsew")
        return frame
    
    def on_load_vods(self):
        name = self.entry_search_streamer.get().strip()
        filter_mode = self.combo_filter.get()
        if not name or not self.token: self.update_status("Login erforderlich / Name fehlt", "red"); return

        # Streamer-Name in Config speichern
        self.config["streamer_name"] = name
        self.save_settings(silent=True)

        def fetch():
            try:
                self.update_status("Lade ID...", "yellow")
                headers = {'Client-ID': self.config["client_id"], 'Authorization': f'Bearer {self.token}'}
                r = self.session.get('https://api.twitch.tv/helix/users', params={'login': name}, headers=headers, timeout=API_TIMEOUT)
                try:
                    json_data = r.json()
                except json.JSONDecodeError:
                    self.update_status("Ungültige API-Antwort", "red")
                    return
                if not json_data.get('data'):
                    self.update_status("Nutzer nicht gefunden", "red")
                    return
                user_data = json_data['data'][0]
                user_id = user_data['id']
                display_name = user_data['display_name']
                self.after(0, lambda dn=display_name: self.title(f"Twitch VOD Manager [{APP_VERSION}] - {dn}"))
                self.update_status(f"Lade {filter_mode} (max 50)...", "yellow")
                
                final_items = []
                v_type = 'highlight' if filter_mode == "Highlights" else 'archive'
                r_v = self.session.get('https://api.twitch.tv/helix/videos', params={'user_id': user_id, 'type': v_type, 'first': 50}, headers=headers, timeout=API_TIMEOUT)
                try:
                    raw_data = r_v.json().get('data', [])
                except json.JSONDecodeError:
                    self.update_status("Ungültige Video-API-Antwort", "red")
                    return
                for item in raw_data:
                    final_items.append({
                        'title': item['title'], 'url': item['url'], 'thumbnail_url': item['thumbnail_url'],
                        'created_at': item['created_at'], 'duration': item['duration'], 'type': 'video'
                    })

                self.after(0, lambda fi=final_items, dn=display_name: self.display_vods(fi, dn))
                self.update_status(f"{len(final_items)} Ergebnisse geladen", "green")
            except Exception as e: self.update_status(f"API Fehler: {e}", "red")
        threading.Thread(target=fetch, daemon=True).start()

    def open_clip_dialog(self, title, url, dt, streamer, dur_str):
        dialog = tk.Toplevel(self)
        dialog.title("Clip erstellen: " + title[:30])
        dialog.geometry("500x580")
        dialog.configure(bg="#2b2b2b")
        dialog.grab_set()

        total_seconds = self.parse_duration_string(dur_str)

        ctk.CTkLabel(dialog, text=f"Clip zuschneiden ({dur_str})", font=("Arial", 14, "bold"), text_color="#E5A00D").pack(pady=10)

        # Slider Frame
        slider_frame = ctk.CTkFrame(dialog, fg_color="transparent")
        slider_frame.pack(fill="x", padx=20, pady=5)

        ctk.CTkLabel(slider_frame, text="Start:").pack(anchor="w")
        start_var = ctk.DoubleVar(value=0)
        slider_start = ctk.CTkSlider(slider_frame, from_=0, to=total_seconds, variable=start_var)
        slider_start.pack(fill="x", pady=(0, 5))

        ctk.CTkLabel(slider_frame, text="Ende:").pack(anchor="w")
        end_var = ctk.DoubleVar(value=min(60, total_seconds))
        slider_end = ctk.CTkSlider(slider_frame, from_=0, to=total_seconds, variable=end_var)
        slider_end.pack(fill="x", pady=(0, 10))

        # Zeit-Eingabefelder
        time_frame = ctk.CTkFrame(dialog, fg_color="transparent")
        time_frame.pack(fill="x", padx=20, pady=5)

        # Start-Zeit
        start_row = ctk.CTkFrame(time_frame, fg_color="transparent")
        start_row.pack(fill="x", pady=3)
        ctk.CTkLabel(start_row, text="Startzeit (HH:MM:SS):", width=150).pack(side="left")
        entry_start = ctk.CTkEntry(start_row, width=100)
        entry_start.insert(0, "00:00:00")
        entry_start.pack(side="left", padx=10)

        # End-Zeit
        end_row = ctk.CTkFrame(time_frame, fg_color="transparent")
        end_row.pack(fill="x", pady=3)
        ctk.CTkLabel(end_row, text="Endzeit (HH:MM:SS):", width=150).pack(side="left")
        entry_end = ctk.CTkEntry(end_row, width=100)
        entry_end.insert(0, self.format_seconds(min(60, total_seconds)))
        entry_end.pack(side="left", padx=10)

        lbl_info = ctk.CTkLabel(dialog, text="", text_color="gray")
        lbl_info.pack(pady=5)

        def parse_time(time_str):
            """Parst HH:MM:SS zu Sekunden"""
            try:
                parts = time_str.strip().split(':')
                if len(parts) == 3:
                    return int(parts[0]) * 3600 + int(parts[1]) * 60 + int(parts[2])
                elif len(parts) == 2:
                    return int(parts[0]) * 60 + int(parts[1])
                else:
                    return int(parts[0])
            except:
                return 0

        updating = [False]  # Flag um Endlos-Loop zu verhindern

        def update_from_slider(*args):
            if updating[0]: return
            updating[0] = True
            entry_start.delete(0, "end")
            entry_start.insert(0, self.format_seconds(int(start_var.get())))
            entry_end.delete(0, "end")
            entry_end.insert(0, self.format_seconds(int(end_var.get())))
            update_info()
            updating[0] = False

        def update_from_entry(*args):
            if updating[0]: return
            updating[0] = True
            s = parse_time(entry_start.get())
            e = parse_time(entry_end.get())
            start_var.set(max(0, min(s, total_seconds)))
            end_var.set(max(0, min(e, total_seconds)))
            update_info()
            updating[0] = False

        def update_info():
            s = parse_time(entry_start.get())
            e = parse_time(entry_end.get())
            s = max(0, min(s, total_seconds))
            e = max(0, min(e, total_seconds))
            if e > s:
                lbl_info.configure(text=f"Dauer: {self.format_seconds(e - s)}", text_color="green")
            else:
                lbl_info.configure(text="Endzeit muss größer als Startzeit sein!", text_color="red")

        slider_start.configure(command=lambda v: update_from_slider())
        slider_end.configure(command=lambda v: update_from_slider())
        entry_start.bind("<KeyRelease>", update_from_entry)
        entry_end.bind("<KeyRelease>", update_from_entry)
        update_info()

        # Part-Nummer Eingabe
        part_frame = ctk.CTkFrame(dialog, fg_color="transparent")
        part_frame.pack(fill="x", padx=20, pady=5)
        ctk.CTkLabel(part_frame, text="Start Part-Nummer (optional, für Fortsetzung):").pack(anchor="w")
        entry_part = ctk.CTkEntry(part_frame, width=100, placeholder_text="z.B. 42")
        entry_part.pack(anchor="w", pady=(3, 0))
        ctk.CTkLabel(part_frame, text="Leer lassen = Part 1", text_color="gray", font=("Arial", 10)).pack(anchor="w")

        # Dateinamen-Format Auswahl
        format_frame = ctk.CTkFrame(dialog, fg_color="transparent")
        format_frame.pack(fill="x", padx=20, pady=5)
        ctk.CTkLabel(format_frame, text="Dateinamen-Format:").pack(anchor="w")
        format_var = ctk.StringVar(value="simple")
        ctk.CTkRadioButton(format_frame, text="01.02.2026_Part25.mp4 (Standard)", variable=format_var, value="simple").pack(anchor="w")
        ctk.CTkRadioButton(format_frame, text="01.02.2026_CLIP_43-30-00_Part25.mp4 (mit Zeitstempel)", variable=format_var, value="timestamp").pack(anchor="w")

        def confirm():
            s = parse_time(entry_start.get())
            e = parse_time(entry_end.get())
            s = max(0, min(s, total_seconds))
            e = max(0, min(e, total_seconds))
            if e <= s:
                messagebox.showerror("Fehler", "Endzeit muss größer als Startzeit sein.")
                return

            # Part-Nummer auslesen
            part_str = entry_part.get().strip()
            start_part = 1
            if part_str and part_str.isdigit():
                start_part = max(1, int(part_str))

            clip_data = {
                'start_sec': s,
                'duration_sec': e - s,
                'start_part': start_part,
                'filename_format': format_var.get()
            }
            self.add_to_queue(title, url, dt, streamer, dur_str, custom_clip=clip_data)
            dialog.destroy()

        ctk.CTkButton(dialog, text="Zur Queue hinzufügen", command=confirm, fg_color="green").pack(pady=20)

    def display_vods(self, videos, streamer_name):
        try:
            for w in self.scroll_results.winfo_children(): 
                w.destroy()
            if not videos: 
                ctk.CTkLabel(self.scroll_results, text="Keine Ergebnisse.").pack(pady=20)
                return

            for v in videos:
                colors = THEMES[self.current_theme_name]
                b_width = colors.get("border_width", 0)
                b_color = colors.get("border_color", "transparent")
                
                if b_color == "transparent" and b_width > 0: b_color = "#333333"

                card = ctk.CTkFrame(self.scroll_results, fg_color=colors.get("bg_card", "gray20"), height=80, border_width=b_width, border_color=b_color)
                card.pack(fill="x", pady=5, padx=5)
                
                raw_url = v.get('thumbnail_url', '') or ""
                thumb_url = raw_url.replace("%{width}", "160").replace("%{height}", "90") if "%{width}" in raw_url else raw_url
                
                lbl_thumb = ctk.CTkLabel(card, text="[BILD]", width=160, height=90, fg_color="black")
                lbl_thumb.pack(side="left", padx=(5, 10), pady=5)
                info_frame = ctk.CTkFrame(card, fg_color="transparent")
                info_frame.pack(side="left", fill="both", expand=True, padx=5, pady=5)
                
                title = v.get('title', 'Unbekannt')
                try: dt = datetime.datetime.strptime(v['created_at'], "%Y-%m-%dT%H:%M:%SZ")
                except: dt = datetime.datetime.now()
                
                dur = v.get('duration', '?')
                
                ctk.CTkLabel(info_frame, text=title, anchor="w", font=ctk.CTkFont(size=14, weight="bold")).pack(fill="x")
                ctk.CTkLabel(info_frame, text=f"{dt.strftime('%d.%m.%Y %H:%M')} | Dauer: {dur}", anchor="w", text_color="gray").pack(fill="x")
                
                btn_box = ctk.CTkFrame(card, fg_color="transparent")
                btn_box.pack(side="right", padx=10, pady=20)
                
                btn_clip = ctk.CTkButton(btn_box, text="✂", width=40, fg_color="#D35400", hover_color="#A04000", command=lambda t=title, u=v['url'], d=dt, s=streamer_name, du=dur: self.open_clip_dialog(t, u, d, s, du))
                btn_clip.pack(side="left", padx=(0, 5))
                CTkToolTip(btn_clip, "Bestimmten Zeitbereich downloaden")

                btn_add = ctk.CTkButton(btn_box, text="➕ Zur Queue", width=100, command=lambda t=title, u=v['url'], d=dt, s=streamer_name, du=dur: self.add_to_queue(t, u, d, s, du))
                btn_add.pack(side="left")
                
                def load_img(u: str, l) -> None:
                    if not u:
                        return
                    try:
                        resp = self.session.get(u, stream=True, timeout=THUMBNAIL_TIMEOUT)
                        if resp.status_code == 200:
                            img_data = Image.open(BytesIO(resp.content))
                            ctk_img = ctk.CTkImage(light_image=img_data, dark_image=img_data, size=(160, 90))
                            l.image = ctk_img  # Keep reference before scheduling
                            l.after(0, lambda img=ctk_img: l.configure(image=img, text=""))
                    except requests.RequestException:
                        pass
                self.thumbnail_executor.submit(load_img, thumb_url, lbl_thumb)
        except Exception as e:
            self.log(f"UI Error: {e}")
            messagebox.showerror("UI Error", f"Fehler beim Anzeigen der Liste:\n{e}")

    def add_to_queue(self, title, url, dt, streamer, dur, custom_clip=None):
        if custom_clip is None:
            for i in self.download_queue:
                # Prüfe erst ob es kein merge_job ist, bevor auf 'url' zugegriffen wird
                if 'is_merge_job' not in i and 'custom_clip' not in i and i.get('url') == url:
                    return 

        colors = THEMES[self.current_theme_name]
        b_width = colors.get("border_width", 0)
        b_color = colors.get("border_color", "transparent")
        
        if b_color == "transparent" and b_width > 0: b_color = "#333333"

        f = ctk.CTkFrame(self.scroll_queue, fg_color=colors["bg_card"], height=40, border_width=b_width, border_color=b_color)
        f.pack(fill="x", pady=2, padx=2)
        
        prefix = "✂ " if custom_clip else ""
        item_ref = {'title': title, 'url': url, 'date': dt, 'streamer': streamer, 'duration_str': dur, 'ui_widget': f}
        if custom_clip:
            item_ref['custom_clip'] = custom_clip

        ctk.CTkButton(f, text="✖", width=30, height=25, fg_color="#C0392B", hover_color="#922B21", command=lambda: self.remove_from_queue(url, f)).pack(side="right", padx=5, pady=5)
        
        btn_merge = ctk.CTkButton(f, text="🔗", width=30, height=25, fg_color="#D35400", hover_color="#A04000", command=lambda i=item_ref: self.open_merge_dialog(i))
        btn_merge.pack(side="right", padx=5, pady=5)
        CTkToolTip(btn_merge, "Verbinden mit...")

        date_label = dt.strftime("%d.%m")
        ctk.CTkLabel(f, text=date_label, width=45, font=ctk.CTkFont(size=12, weight="bold"), text_color="#E5A00D").pack(side="left", padx=5)
        
        disp_title = (title[:25]+"...") if len(title)>25 else title
        l = ctk.CTkLabel(f, text=prefix + disp_title, anchor="w", font=ctk.CTkFont(size=12))
        l.pack(side="left", fill="x", expand=True, padx=5)
        CTkToolTip(l, title)
        
        self.download_queue.append(item_ref)
        self.lbl_queue_title.configure(text=f"Warteschlange ({len(self.download_queue)}):")

    def remove_from_queue(self, url, widget):
        self.download_queue = [x for x in self.download_queue if x.get('ui_widget') != widget]
        widget.destroy()
        self.lbl_queue_title.configure(text=f"Warteschlange ({len(self.download_queue)}):")

    def update_status(self, text, color):
        # Thread-safe: UI-Updates immer über after()
        self.after(0, lambda: self.lbl_status.configure(text=text, text_color=color))

    def log(self, msg):
        def do_log():
            try:
                ts = datetime.datetime.now().strftime("%H:%M")
                self.textbox_log.configure(state="normal")
                self.textbox_log.insert("end", f"[{ts}] {msg}\n")
                self.textbox_log.see("end")
                self.textbox_log.configure(state="disabled")
            except:
                print(msg)
        # Thread-safe: UI-Updates immer über after()
        try:
            self.after(0, do_log)
        except:
            print(msg)

    def load_config(self):
        # Standard download_path auf Desktop\Twitch_VODs
        default = {
            "client_id": "", "client_secret": "", "download_path": DEFAULT_DOWNLOAD_PATH,
            "streamer_name": "", "part_minutes": 120, "download_mode": "parts",
            "upload_to_youtube": False, "youtube_desc": "Auto-Upload", "firefox_profile_path": "",
            "theme": "Default"
        }
        if os.path.exists(CONFIG_FILE):
            try:
                with open(CONFIG_FILE, "r", encoding="utf-8") as f:
                    data = json.load(f)
                    config = {**default, **data}
                    # Wenn download_path leer ist, auf Desktop setzen
                    if not config.get("download_path", "").strip():
                        config["download_path"] = DEFAULT_DOWNLOAD_PATH
                    # Download-Ordner erstellen falls nicht vorhanden
                    if config["download_path"] and not os.path.exists(config["download_path"]):
                        try:
                            os.makedirs(config["download_path"], exist_ok=True)
                        except:
                            pass
                    return config
            except:
                pass
        # Download-Ordner erstellen falls nicht vorhanden
        if not os.path.exists(DEFAULT_DOWNLOAD_PATH):
            try:
                os.makedirs(DEFAULT_DOWNLOAD_PATH, exist_ok=True)
            except:
                pass
        return default

    def save_part_minutes(self) -> None:
        """Part-Minuten speichern."""
        try:
            value = self.entry_minutes.get().strip()
            if value and value.isdigit():
                self.config["part_minutes"] = int(value)
                with open(CONFIG_FILE, "w", encoding="utf-8") as f:
                    json.dump(self.config, f, indent=4)
                self.log(f"Part-Länge auf {value} Minuten gesetzt.")
        except (ValueError, AttributeError):
            pass

    def save_settings(self, silent=False):
        # Alte Credentials merken um zu prüfen ob neu eingeloggt werden muss
        old_client_id = self.config.get("client_id", "")
        old_client_secret = self.config.get("client_secret", "")

        self.config["client_id"] = self.entry_client_id.get().strip()
        self.config["client_secret"] = self.entry_client_secret.get().strip()
        self.config["download_path"] = self.entry_path.get().strip()
        self.config["download_mode"] = "parts" if "Parts" in self.seg_mode.get() else "full"
        if hasattr(self, 'chk_upload_val'):
            self.config["upload_to_youtube"] = self.chk_upload_val.get()
        if hasattr(self, 'entry_profile_path'):
            self.config["firefox_profile_path"] = self.entry_profile_path.get().strip()
        if hasattr(self, 'var_theme'):
            self.config["theme"] = self.var_theme.get()
        if hasattr(self, 'entry_minutes'):
            try:
                val = self.entry_minutes.get().strip()
                if val and val.isdigit():
                    self.config["part_minutes"] = int(val)
            except:
                pass
        try:
            with open(CONFIG_FILE, "w", encoding="utf-8") as f:
                json.dump(self.config, f, indent=4)
        except IOError as e:
            self.log(f"Fehler beim Speichern der Konfiguration: {e}")
            return
        if not silent:
            self.log("Gespeichert.")
            # Nur neu einloggen wenn Credentials geändert wurden
            credentials_changed = (old_client_id != self.config["client_id"] or
                                   old_client_secret != self.config["client_secret"])
            if credentials_changed and self.config["client_id"] and self.config["client_secret"]:
                threading.Thread(target=self.perform_login, daemon=True).start()

    def browse_folder(self):
        f = filedialog.askdirectory()
        if f: 
            self.entry_path.delete(0, "end")
            self.entry_path.insert(0, f)
            self.save_settings(silent=True)
    
    def open_save_folder(self):
        path = self.entry_path.get().strip()
        if os.path.exists(path):
            try:
                os.startfile(path)
            except Exception as e:
                self.log(f"Fehler beim Öffnen: {e}")
        else:
            self.log("Ordner existiert nicht.")

    # ==========================================
    # AUTO-UPDATER
    # ==========================================
    def check_for_updates_on_startup(self):
        """Prüft beim Start auf Updates und zeigt Popup wenn verfügbar."""
        threading.Thread(target=self._startup_update_check, daemon=True).start()

    def _startup_update_check(self):
        """Background-Check beim Start."""
        try:
            import urllib.request
            req = urllib.request.Request(UPDATE_CHECK_URL, headers={'User-Agent': 'Twitch-VOD-Manager'})
            with urllib.request.urlopen(req, timeout=10) as response:
                data = json.loads(response.read().decode('utf-8'))

            server_version = data.get('version', '0.0.0')
            download_url = data.get('download_url', '')
            changelog = data.get('changelog', '')

            current = APP_VERSION.replace('v', '').strip()
            server = server_version.replace('v', '').strip()

            def parse_version(v):
                try:
                    return tuple(map(int, v.split('.')))
                except:
                    return (0, 0, 0)

            if parse_version(server) > parse_version(current):
                self.latest_update_url = download_url
                self.latest_update_version = server_version
                self.latest_update_changelog = changelog
                self.after(500, lambda: self._show_update_popup(server_version, changelog))
        except:
            pass  # Silent fail beim Start

    def _show_update_popup(self, version, changelog):
        """Zeigt ein schönes Update-Popup."""
        popup = ctk.CTkToplevel(self)
        popup.title("Update verfügbar")
        popup.geometry("450x320")
        popup.resizable(False, False)
        popup.grab_set()
        popup.configure(fg_color="#1a1a2e")

        # Zentrieren
        popup.update_idletasks()
        x = self.winfo_x() + (self.winfo_width() // 2) - 225
        y = self.winfo_y() + (self.winfo_height() // 2) - 160
        popup.geometry(f"+{x}+{y}")

        # Header mit Icon
        header = ctk.CTkFrame(popup, fg_color="#16213e", corner_radius=10)
        header.pack(fill="x", padx=20, pady=(20, 10))
        ctk.CTkLabel(header, text="🚀  Neues Update verfügbar!", font=("Arial", 18, "bold"), text_color="#00d4ff").pack(pady=15)

        # Version Info
        info_frame = ctk.CTkFrame(popup, fg_color="transparent")
        info_frame.pack(fill="x", padx=20, pady=5)
        ctk.CTkLabel(info_frame, text=f"Aktuelle Version:", font=("Arial", 12), text_color="gray").pack(anchor="w")
        ctk.CTkLabel(info_frame, text=f"{APP_VERSION}", font=("Arial", 14, "bold")).pack(anchor="w")
        ctk.CTkLabel(info_frame, text=f"Neue Version:", font=("Arial", 12), text_color="gray").pack(anchor="w", pady=(10,0))
        ctk.CTkLabel(info_frame, text=f"v{version}", font=("Arial", 14, "bold"), text_color="#00ff88").pack(anchor="w")

        # Changelog
        if changelog:
            ctk.CTkLabel(info_frame, text=f"📋 {changelog}", font=("Arial", 11), text_color="#aaaaaa", wraplength=360).pack(anchor="w", pady=(10,0))

        # Buttons
        btn_frame = ctk.CTkFrame(popup, fg_color="transparent")
        btn_frame.pack(fill="x", padx=20, pady=20)

        ctk.CTkButton(
            btn_frame, text="⬇ Jetzt updaten", width=180, height=40,
            font=("Arial", 14, "bold"), fg_color="#00aa55", hover_color="#008844",
            command=lambda: self._start_silent_update(popup)
        ).pack(side="left", padx=(0, 10))

        ctk.CTkButton(
            btn_frame, text="Später", width=180, height=40,
            font=("Arial", 14), fg_color="#555555", hover_color="#444444",
            command=popup.destroy
        ).pack(side="right")

    def check_for_updates(self):
        """Manueller Update-Check aus Einstellungen."""
        self.btn_check_update.configure(state="disabled", text="Suche...")
        self.lbl_update_status.configure(text="Suche nach Updates...", text_color="yellow")
        threading.Thread(target=self._manual_update_check, daemon=True).start()

    def _manual_update_check(self):
        """Thread für manuellen Update-Check."""
        try:
            import urllib.request
            req = urllib.request.Request(UPDATE_CHECK_URL, headers={'User-Agent': 'Twitch-VOD-Manager'})
            with urllib.request.urlopen(req, timeout=10) as response:
                data = json.loads(response.read().decode('utf-8'))

            server_version = data.get('version', '0.0.0')
            download_url = data.get('download_url', '')
            changelog = data.get('changelog', '')

            current = APP_VERSION.replace('v', '').strip()
            server = server_version.replace('v', '').strip()

            def parse_version(v):
                try:
                    return tuple(map(int, v.split('.')))
                except:
                    return (0, 0, 0)

            if parse_version(server) > parse_version(current):
                self.latest_update_url = download_url
                self.latest_update_version = server_version
                self.latest_update_changelog = changelog
                self.after(0, lambda: self._show_update_in_settings(server_version, changelog))
            else:
                self.after(0, self._show_no_update)

        except Exception as e:
            self.after(0, lambda: self._show_update_error(str(e)))

    def _show_update_in_settings(self, version, changelog):
        """Zeigt Update-Info in Einstellungen."""
        self.btn_check_update.configure(state="normal", text="Nach Updates suchen")
        self.lbl_update_status.configure(
            text=f"✨ Update verfügbar: v{version}\n📋 {changelog}",
            text_color="#00ff88"
        )
        self.btn_download_update.configure(state="normal")

    def _show_no_update(self):
        """Zeigt an dass kein Update verfügbar ist."""
        self.btn_check_update.configure(state="normal", text="Nach Updates suchen")
        self.lbl_update_status.configure(text="✅ Du hast die neueste Version!", text_color="#00ff88")
        self.btn_download_update.configure(state="disabled")

    def _show_update_error(self, error):
        """Zeigt Update-Fehler an."""
        self.btn_check_update.configure(state="normal", text="Nach Updates suchen")
        self.lbl_update_status.configure(text=f"❌ Fehler: {error}", text_color="red")
        self.btn_download_update.configure(state="disabled")

    def download_and_install_update(self):
        """Startet Update aus Einstellungen."""
        if not hasattr(self, 'latest_update_url') or not self.latest_update_url:
            self.lbl_update_status.configure(text="Keine Update-URL!", text_color="red")
            return
        self._start_silent_update(None)

    def _start_silent_update(self, popup=None):
        """Startet Silent-Update mit Progress-Dialog."""
        if popup:
            popup.destroy()

        # Progress Dialog
        self.update_dialog = ctk.CTkToplevel(self)
        self.update_dialog.title("Update wird installiert...")
        self.update_dialog.geometry("400x150")
        self.update_dialog.resizable(False, False)
        self.update_dialog.grab_set()
        self.update_dialog.configure(fg_color="#1a1a2e")

        self.update_dialog.update_idletasks()
        x = self.winfo_x() + (self.winfo_width() // 2) - 200
        y = self.winfo_y() + (self.winfo_height() // 2) - 75
        self.update_dialog.geometry(f"+{x}+{y}")

        ctk.CTkLabel(self.update_dialog, text="⬇ Update wird heruntergeladen...", font=("Arial", 14, "bold")).pack(pady=(20, 10))
        self.update_progress = ctk.CTkProgressBar(self.update_dialog, width=350)
        self.update_progress.pack(pady=10)
        self.update_progress.set(0)
        self.update_status_label = ctk.CTkLabel(self.update_dialog, text="0%", font=("Arial", 12))
        self.update_status_label.pack()

        threading.Thread(target=self._download_and_install_silent, daemon=True).start()

    def _download_and_install_silent(self):
        """Download und Silent-Installation - Komplett überarbeitet."""
        try:
            import urllib.request
            import tempfile

            temp_dir = tempfile.gettempdir()
            installer_path = os.path.join(temp_dir, "Twitch_VOD_Manager_Update.exe")

            req = urllib.request.Request(self.latest_update_url, headers={'User-Agent': 'Twitch-VOD-Manager'})

            with urllib.request.urlopen(req, timeout=300) as response:
                total_size = int(response.headers.get('Content-Length', 0))
                downloaded = 0
                chunk_size = 65536

                with open(installer_path, 'wb') as f:
                    while True:
                        chunk = response.read(chunk_size)
                        if not chunk:
                            break
                        f.write(chunk)
                        downloaded += len(chunk)
                        if total_size > 0:
                            progress = downloaded / total_size
                            percent = int(progress * 100)
                            self.after(0, lambda p=progress, pct=percent: self._update_progress(p, pct))

            # Download fertig
            self.after(0, lambda: self.update_status_label.configure(text="Starte Installation..."))
            self.after(0, lambda: self.update_progress.set(1.0))

            # VBScript erstellen das den Installer unsichtbar startet
            vbs_path = os.path.join(temp_dir, "run_update.vbs")
            with open(vbs_path, 'w') as f:
                f.write('Set WshShell = CreateObject("WScript.Shell")\n')
                f.write(f'WshShell.Run """{installer_path}"" /VERYSILENT /SUPPRESSMSGBOXES /NORESTART /CLOSEAPPLICATIONS /RESTARTAPPLICATIONS", 0, False\n')

            # VBScript starten (läuft komplett unsichtbar)
            os.startfile(vbs_path)

            # Installer schließt die App via /CLOSEAPPLICATIONS - wir warten nur kurz
            self.after(2000, self.destroy)

        except Exception as e:
            self.after(0, lambda: self.update_status_label.configure(text=f"Fehler: {e}"))
            self.after(3000, lambda: self.update_dialog.destroy() if hasattr(self, 'update_dialog') else None)

    def _update_progress(self, progress, percent):
        """Aktualisiert Progress-Dialog."""
        if hasattr(self, 'update_progress'):
            self.update_progress.set(progress)
        if hasattr(self, 'update_status_label'):
            self.update_status_label.configure(text=f"{percent}%")

    def perform_login(self) -> None:
        try:
            resp = self.session.post(
                'https://id.twitch.tv/oauth2/token',
                params={
                    'client_id': self.config["client_id"],
                    'client_secret': self.config["client_secret"],
                    'grant_type': 'client_credentials'
                },
                timeout=API_TIMEOUT
            )
            if resp.status_code == 200:
                try:
                    self.token = resp.json().get('access_token')
                    self.log("Login erfolgreich.")
                except json.JSONDecodeError:
                    self.log("Login Fehler: Ungültige API-Antwort")
            else:
                self.log(f"Login Fehler: {resp.status_code}")
        except requests.RequestException as e:
            self.log(f"Conn Error: {e}")

if __name__ == "__main__":
    try: 
        app = TwitchDownloaderApp()
        app.mainloop()
    except Exception as e: 
        log_crash(e)