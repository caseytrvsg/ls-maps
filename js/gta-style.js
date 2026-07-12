// LS Maps — GTA-inspired map theme
// Original styling (not Rockstar assets). Data: OpenStreetMap via OpenFreeMap vector tiles.
// Palette: dark charcoal land, near-white roads with dark casings, steel-teal water,
// muted olive parks, sandy beaches — evokes the GTA V pause-menu map.

window.GTA_STYLE = {
  version: 8,
  name: "LS Maps — Los Santos Dark",
  glyphs: "https://tiles.openfreemap.org/fonts/{fontstack}/{range}.pbf",
  sources: {
    omt: {
      type: "vector",
      url: "https://tiles.openfreemap.org/planet"
    }
  },
  layers: [
    {
      id: "background",
      type: "background",
      paint: { "background-color": "#33383D" }
    },
    {
      id: "landuse-residential",
      type: "fill",
      source: "omt",
      "source-layer": "landuse",
      filter: ["in", ["get", "class"], ["literal", ["residential", "suburb", "neighbourhood"]]],
      paint: { "fill-color": "#373C41", "fill-opacity": 0.8 }
    },
    {
      id: "landuse-industrial",
      type: "fill",
      source: "omt",
      "source-layer": "landuse",
      filter: ["in", ["get", "class"], ["literal", ["industrial", "commercial", "retail"]]],
      paint: { "fill-color": "#3A3E42", "fill-opacity": 0.7 }
    },
    {
      id: "landcover-wood",
      type: "fill",
      source: "omt",
      "source-layer": "landcover",
      filter: ["==", ["get", "class"], "wood"],
      paint: { "fill-color": "#36423A", "fill-opacity": 0.85 }
    },
    {
      id: "landcover-grass",
      type: "fill",
      source: "omt",
      "source-layer": "landcover",
      filter: ["==", ["get", "class"], "grass"],
      paint: { "fill-color": "#3A463C", "fill-opacity": 0.7 }
    },
    {
      id: "landcover-sand",
      type: "fill",
      source: "omt",
      "source-layer": "landcover",
      filter: ["==", ["get", "class"], "sand"],
      paint: { "fill-color": "#565039", "fill-opacity": 0.9 }
    },
    {
      id: "park",
      type: "fill",
      source: "omt",
      "source-layer": "park",
      paint: { "fill-color": "#3A4A3C", "fill-opacity": 0.75 }
    },
    {
      id: "water",
      type: "fill",
      source: "omt",
      "source-layer": "water",
      paint: { "fill-color": "#1F4E63" }
    },
    {
      id: "waterway",
      type: "line",
      source: "omt",
      "source-layer": "waterway",
      paint: {
        "line-color": "#1F4E63",
        "line-width": ["interpolate", ["exponential", 1.4], ["zoom"], 8, 0.6, 14, 2.5, 18, 8]
      }
    },
    {
      id: "aeroway",
      type: "line",
      source: "omt",
      "source-layer": "aeroway",
      minzoom: 10,
      filter: ["in", ["get", "class"], ["literal", ["runway", "taxiway"]]],
      paint: {
        "line-color": "#4A4F55",
        "line-width": ["interpolate", ["exponential", 1.4], ["zoom"], 10, 1, 14, 6, 17, 24]
      }
    },
    {
      id: "building",
      type: "fill",
      source: "omt",
      "source-layer": "building",
      minzoom: 13.5,
      paint: {
        "fill-color": "#3C4248",
        "fill-opacity": ["interpolate", ["linear"], ["zoom"], 13.5, 0, 15, 0.7]
      }
    },

    // ---- Tunnels (dimmer, dashed casing) ----
    {
      id: "tunnel-road",
      type: "line",
      source: "omt",
      "source-layer": "transportation",
      filter: ["all",
        ["==", ["get", "brunnel"], "tunnel"],
        ["in", ["get", "class"], ["literal", ["motorway", "trunk", "primary", "secondary", "tertiary", "minor"]]]
      ],
      layout: { "line-cap": "butt", "line-join": "round" },
      paint: {
        "line-color": "#6E747A",
        "line-dasharray": [2, 1.5],
        "line-width": ["interpolate", ["exponential", 1.4], ["zoom"], 8, 0.8, 13, 3, 16, 8, 18, 18]
      }
    },

    // ---- Road casings (dark outline under the light fill) ----
    {
      id: "road-service-casing",
      type: "line",
      source: "omt",
      "source-layer": "transportation",
      minzoom: 14,
      filter: ["all",
        ["!=", ["get", "brunnel"], "tunnel"],
        ["in", ["get", "class"], ["literal", ["service", "track"]]]
      ],
      layout: { "line-cap": "round", "line-join": "round" },
      paint: {
        "line-color": "#17191C",
        "line-width": ["interpolate", ["exponential", 1.4], ["zoom"], 14, 1.6, 17, 5, 19, 12]
      }
    },
    {
      id: "road-minor-casing",
      type: "line",
      source: "omt",
      "source-layer": "transportation",
      minzoom: 11,
      filter: ["all",
        ["!=", ["get", "brunnel"], "tunnel"],
        ["==", ["get", "class"], "minor"]
      ],
      layout: { "line-cap": "round", "line-join": "round" },
      paint: {
        "line-color": "#17191C",
        "line-width": ["interpolate", ["exponential", 1.4], ["zoom"], 11, 1.2, 14, 3.2, 17, 9, 19, 20]
      }
    },
    {
      id: "road-mid-casing",
      type: "line",
      source: "omt",
      "source-layer": "transportation",
      minzoom: 9,
      filter: ["all",
        ["!=", ["get", "brunnel"], "tunnel"],
        ["in", ["get", "class"], ["literal", ["secondary", "tertiary"]]]
      ],
      layout: { "line-cap": "round", "line-join": "round" },
      paint: {
        "line-color": "#17191C",
        "line-width": ["interpolate", ["exponential", 1.4], ["zoom"], 9, 1.4, 13, 4, 16, 10, 19, 26]
      }
    },
    {
      id: "road-major-casing",
      type: "line",
      source: "omt",
      "source-layer": "transportation",
      minzoom: 7,
      filter: ["all",
        ["!=", ["get", "brunnel"], "tunnel"],
        ["in", ["get", "class"], ["literal", ["primary", "trunk"]]]
      ],
      layout: { "line-cap": "round", "line-join": "round" },
      paint: {
        "line-color": "#17191C",
        "line-width": ["interpolate", ["exponential", 1.4], ["zoom"], 7, 1.4, 12, 4.4, 16, 12, 19, 30]
      }
    },
    {
      id: "road-motorway-casing",
      type: "line",
      source: "omt",
      "source-layer": "transportation",
      minzoom: 5,
      filter: ["all",
        ["!=", ["get", "brunnel"], "tunnel"],
        ["==", ["get", "class"], "motorway"]
      ],
      layout: { "line-cap": "round", "line-join": "round" },
      paint: {
        "line-color": "#141619",
        "line-width": ["interpolate", ["exponential", 1.4], ["zoom"], 5, 1.6, 10, 4, 14, 9, 17, 16, 19, 34]
      }
    },

    // ---- Road fills (the light GTA-style strokes) ----
    {
      id: "road-service",
      type: "line",
      source: "omt",
      "source-layer": "transportation",
      minzoom: 14,
      filter: ["all",
        ["!=", ["get", "brunnel"], "tunnel"],
        ["in", ["get", "class"], ["literal", ["service", "track"]]]
      ],
      layout: { "line-cap": "round", "line-join": "round" },
      paint: {
        "line-color": "#84898F",
        "line-width": ["interpolate", ["exponential", 1.4], ["zoom"], 14, 0.7, 17, 3, 19, 8]
      }
    },
    {
      id: "road-minor",
      type: "line",
      source: "omt",
      "source-layer": "transportation",
      minzoom: 11,
      filter: ["all",
        ["!=", ["get", "brunnel"], "tunnel"],
        ["==", ["get", "class"], "minor"]
      ],
      layout: { "line-cap": "round", "line-join": "round" },
      paint: {
        "line-color": "#A9AEB4",
        "line-width": ["interpolate", ["exponential", 1.4], ["zoom"], 11, 0.6, 14, 2, 17, 6.5, 19, 16]
      }
    },
    {
      id: "road-mid",
      type: "line",
      source: "omt",
      "source-layer": "transportation",
      minzoom: 9,
      filter: ["all",
        ["!=", ["get", "brunnel"], "tunnel"],
        ["in", ["get", "class"], ["literal", ["secondary", "tertiary"]]]
      ],
      layout: { "line-cap": "round", "line-join": "round" },
      paint: {
        "line-color": "#C9CED3",
        "line-width": ["interpolate", ["exponential", 1.4], ["zoom"], 9, 0.8, 13, 2.6, 16, 7.5, 19, 21]
      }
    },
    {
      id: "road-major",
      type: "line",
      source: "omt",
      "source-layer": "transportation",
      minzoom: 7,
      filter: ["all",
        ["!=", ["get", "brunnel"], "tunnel"],
        ["in", ["get", "class"], ["literal", ["primary", "trunk"]]]
      ],
      layout: { "line-cap": "round", "line-join": "round" },
      paint: {
        "line-color": "#E4E8EB",
        "line-width": ["interpolate", ["exponential", 1.4], ["zoom"], 7, 0.9, 12, 3, 16, 9, 19, 24]
      }
    },
    {
      id: "road-motorway",
      type: "line",
      source: "omt",
      "source-layer": "transportation",
      minzoom: 5,
      filter: ["all",
        ["!=", ["get", "brunnel"], "tunnel"],
        ["==", ["get", "class"], "motorway"]
      ],
      layout: { "line-cap": "round", "line-join": "round" },
      paint: {
        "line-color": "#F2F5F7",
        "line-width": ["interpolate", ["exponential", 1.4], ["zoom"], 5, 1, 10, 2.8, 14, 6.5, 17, 12, 19, 27]
      }
    },

    // ---- Labels ----
    {
      id: "road-name",
      type: "symbol",
      source: "omt",
      "source-layer": "transportation_name",
      minzoom: 13.5,
      filter: ["in", ["get", "class"], ["literal", ["motorway", "trunk", "primary", "secondary", "tertiary", "minor"]]],
      layout: {
        "symbol-placement": "line",
        "text-field": ["get", "name"],
        "text-font": ["Noto Sans Regular"],
        "text-size": ["interpolate", ["linear"], ["zoom"], 13.5, 9.5, 18, 13],
        "text-transform": "uppercase",
        "text-letter-spacing": 0.08
      },
      paint: {
        "text-color": "#C4C9CE",
        "text-halo-color": "#17191C",
        "text-halo-width": 1.3
      }
    },
    {
      id: "water-name",
      type: "symbol",
      source: "omt",
      "source-layer": "water_name",
      layout: {
        "text-field": ["get", "name"],
        "text-font": ["Noto Sans Italic"],
        "text-size": 12,
        "text-letter-spacing": 0.1
      },
      paint: {
        "text-color": "#6F9DB3",
        "text-halo-color": "#152833",
        "text-halo-width": 1
      }
    },
    {
      id: "place-neighbourhood",
      type: "symbol",
      source: "omt",
      "source-layer": "place",
      minzoom: 12,
      filter: ["in", ["get", "class"], ["literal", ["suburb", "neighbourhood", "quarter"]]],
      layout: {
        "text-field": ["get", "name"],
        "text-font": ["Noto Sans Bold"],
        "text-size": 11,
        "text-transform": "uppercase",
        "text-letter-spacing": 0.18
      },
      paint: {
        "text-color": "#A9B0B6",
        "text-halo-color": "#1A1D20",
        "text-halo-width": 1.4
      }
    },
    {
      id: "place-village",
      type: "symbol",
      source: "omt",
      "source-layer": "place",
      minzoom: 11,
      filter: ["==", ["get", "class"], "village"],
      layout: {
        "text-field": ["get", "name"],
        "text-font": ["Noto Sans Regular"],
        "text-size": 12
      },
      paint: {
        "text-color": "#C9CED3",
        "text-halo-color": "#1A1D20",
        "text-halo-width": 1.4
      }
    },
    {
      id: "place-town",
      type: "symbol",
      source: "omt",
      "source-layer": "place",
      minzoom: 9,
      filter: ["==", ["get", "class"], "town"],
      layout: {
        "text-field": ["get", "name"],
        "text-font": ["Noto Sans Bold"],
        "text-size": ["interpolate", ["linear"], ["zoom"], 9, 12, 14, 15]
      },
      paint: {
        "text-color": "#DDE1E4",
        "text-halo-color": "#1A1D20",
        "text-halo-width": 1.5
      }
    },
    {
      id: "place-city",
      type: "symbol",
      source: "omt",
      "source-layer": "place",
      minzoom: 4,
      maxzoom: 14,
      filter: ["==", ["get", "class"], "city"],
      layout: {
        "text-field": ["get", "name"],
        "text-font": ["Noto Sans Bold"],
        "text-size": ["interpolate", ["linear"], ["zoom"], 4, 12, 8, 15, 12, 19],
        "text-transform": "uppercase",
        "text-letter-spacing": 0.12
      },
      paint: {
        "text-color": "#EEF1F3",
        "text-halo-color": "#1A1D20",
        "text-halo-width": 1.7
      }
    }
  ]
};
