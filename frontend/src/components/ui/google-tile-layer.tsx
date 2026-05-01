import { useEffect, useRef, useState } from "react"
import { useMap } from "react-leaflet"
import GoogleMutant from "leaflet.gridlayer.googlemutant"

const GOOGLE_MAPS_API_KEY = import.meta.env.VITE_GOOGLE_MAPS_API_KEY as string | undefined

let googleMapsLoading: Promise<void> | null = null
let googleMapsAuthError: string | null = null

// Google calls this global function when API key auth fails
declare global {
  interface Window { gm_authFailure?: () => void }
}

function loadGoogleMapsApi(): Promise<void> {
  if (googleMapsAuthError) return Promise.reject(new Error(googleMapsAuthError))
  if (window.google?.maps) return Promise.resolve()
  if (googleMapsLoading) return googleMapsLoading

  googleMapsLoading = new Promise<void>((resolve, reject) => {
    if (!GOOGLE_MAPS_API_KEY) {
      reject(new Error("VITE_GOOGLE_MAPS_API_KEY is not set — add it to frontend/.env"))
      return
    }

    // Capture Google auth failures (ApiTargetBlockedMapError, InvalidKeyMapError, etc.)
    window.gm_authFailure = () => {
      googleMapsAuthError = "Google Maps API key is not authorized for Maps JavaScript API. Enable it in Google Cloud Console → APIs & Services."
      reject(new Error(googleMapsAuthError))
    }

    const script = document.createElement("script")
    script.src = `https://maps.googleapis.com/maps/api/js?key=${GOOGLE_MAPS_API_KEY}&loading=async`
    script.async = true
    script.onload = () => {
      // Give gm_authFailure a moment to fire (it fires after onload)
      setTimeout(() => {
        if (googleMapsAuthError) {
          reject(new Error(googleMapsAuthError))
        } else {
          resolve()
        }
      }, 500)
    }
    script.onerror = () => reject(new Error("Failed to load Google Maps API script"))
    document.head.appendChild(script)
  })
  return googleMapsLoading
}

export default function GoogleTileLayer() {
  const map = useMap()
  const layerRef = useRef<L.GridLayer | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false

    loadGoogleMapsApi()
      .then(() => {
        if (cancelled) return
        // @ts-expect-error GoogleMutant extends GridLayer but types don't align perfectly
        const layer = new GoogleMutant({ type: "roadmap" })
        layer.addTo(map)
        layerRef.current = layer
      })
      .catch((err) => {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : "Google Maps failed to load")
        }
      })

    return () => {
      cancelled = true
      if (layerRef.current) {
        map.removeLayer(layerRef.current)
        layerRef.current = null
      }
    }
  }, [map])

  if (error) {
    return (
      <div style={{
        position: "absolute", top: 8, left: 8, right: 8, zIndex: 1000,
        background: "#fef2f2", border: "1px solid #fca5a5", borderRadius: 4,
        padding: "6px 10px", fontSize: 12, color: "#b91c1c",
      }}>
        Map tiles failed: {error}
      </div>
    )
  }

  return null
}
