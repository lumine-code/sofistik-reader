{
  "targets": [
    {
      "target_name": "sofistik_reader",
      "sources": ["src/cdb-reader.cc"],
      "include_dirs": ["<!@(node -p \"require('node-addon-api').include\")"],
      "dependencies": ["<!(node -p \"require('node-addon-api').gyp\")"],
      "cflags!": ["-fno-exceptions"],
      "cflags_cc!": ["-fno-exceptions"],
      "defines": ["NAPI_CPP_EXCEPTIONS", "NAPI_VERSION=10"],
      "conditions": [
        [
          "OS=='win'",
          {
            "msvs_settings": {
              "VCCLCompilerTool": {
                "AdditionalOptions": ["/std:c++20", "/utf-8"],
                "ExceptionHandling": "1"
              }
            }
          }
        ],
        [
          "OS=='mac'",
          {
            # node-gyp disables exceptions on macOS through xcode_settings, which
            # the cflags_cc! above cannot reach, and node-addon-api throws.
            "xcode_settings": {
              "GCC_ENABLE_CPP_EXCEPTIONS": "YES"
            }
          }
        ],
        ["OS!='win'", {"defines": ["SOFISTIK_CDB_UNSUPPORTED_PLATFORM"]}]
      ]
    }
  ]
}
