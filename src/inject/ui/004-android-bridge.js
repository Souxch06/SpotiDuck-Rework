  /* ------------------------------------------------------------------ *
   * 3. Android bridge (optional)
   * ------------------------------------------------------------------ */
  var Bridge = {
    has: function (name) {
      return !!(window.AndBridge && typeof window.AndBridge[name] === "function");
    },
    call: function (name) {
      if (!this.has(name)) return null;
      var args = Array.prototype.slice.call(arguments, 1);
      try {
        return window.AndBridge[name].apply(window.AndBridge, args);
      } catch (e) {
        return null;
      }
    },
    /** Payload keys kept identical to the previous implementation so the
     *  existing Kotlin/Java notification code keeps working untouched. */
    mediaStatus: function (s) {
      /* le moteur d'origine lit le même état (voir `Engine.sync`) */
      try {
        Engine.sync(s);
      } catch (e) {
        /* jamais au détriment du rapport */
      }
      this.call(
        "recMediaStatus",
        JSON.stringify({
          track: s.title || "",
          artist: s.artist || "",
          playing: !!s.playing,
          repeat: s.repeat === "context" ? "true" : s.repeat === "track" ? "mixed" : "false",
          fav: !!s.liked,
          duration: s.duration || 0,
          position: Math.round(s.position || 0),
          cover: s.cover || "",
        })
      );
    },
    mediaPosition: function (ms) {
      this.call("recMediaPosition", Math.round(ms || 0));
    },
    playLoaded: function () {
      this.call("playLoaded");
    },
    uiReady: function () {
      this.call("cssInjected");
    },
    shutdownLock: function (wantShut) {
      this.call("manageTShut", !!wantShut);
    },
    sleepLock: function (wantSleep) {
      this.call("manageTSleep", !!wantSleep);
    },
    wakeUp: function () {
      this.call("wakeUp");
    },
    wakeOff: function () {
      this.call("wakeOff");
    },
    isWoke: function () {
      return this.call("isWoke") === true;
    },
    defer: function (message) {
      this.call("deferMessage", message);
    },
  };

