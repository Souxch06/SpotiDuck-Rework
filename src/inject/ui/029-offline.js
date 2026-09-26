  /* ------------------------------------------------------------------ *
   * 11f. Offline — banner + toast so silence never looks like a bug
   * ------------------------------------------------------------------ */
  var Offline = {
    check: function () {
      var off = navigator.onLine === false;
      document.documentElement.classList.toggle("sd-offline", off);
      if (off) Toast.show(Settings.labels.offline, 2600);
    },
  };

