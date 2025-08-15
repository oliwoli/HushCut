package main

import (
	"bytes"
	"crypto"
	"crypto/rsa"
	"crypto/sha256"
	"crypto/x509"
	"encoding/base64"
	"encoding/json"
	"encoding/pem"
	"errors"
	"fmt"
	"io"
	"log"
	"net/http"
	"os"
	"path"
	"time"
)

// verifySignature checks if the data was signed by your private key.
func (a *App) verifySignature(data map[string]interface{}, signatureB64 string) error {
	// Parse public key
	block, _ := pem.Decode(a.licenseVerifyKey)
	if block == nil || block.Type != "PUBLIC KEY" {
		return errors.New("invalid public key embedded in application")
	}

	pubKey, err := x509.ParsePKIXPublicKey(block.Bytes)
	if err != nil {
		return fmt.Errorf("failed to parse public key: %w", err)
	}

	rsaPubKey, ok := pubKey.(*rsa.PublicKey)
	if !ok {
		return errors.New("not an RSA public key")
	}

	// Serialize the data map to JSON. Note that Go's map iteration order is not
	// guaranteed, but json.Marshal sorts keys by default, which is what we need
	// for a consistent hash.
	serialized, err := json.Marshal(data)
	if err != nil {
		return fmt.Errorf("failed to serialize data for verification: %w", err)
	}
	hash := sha256.Sum256(serialized)

	// Decode the signature from Base64
	signature, err := base64.StdEncoding.DecodeString(signatureB64)
	if err != nil {
		return fmt.Errorf("failed to decode signature: %w", err)
	}

	// Verify the signature against the hash
	return rsa.VerifyPKCS1v15(rsaPubKey, crypto.SHA256, hash[:], signature)
}

type SignedLicenseData struct {
	Data      map[string]interface{} `json:"data"`
	Signature string                 `json:"signature"`
}

// loadAndVerifyLocalLicense attempts to read, decode, and verify the license file.
func (a *App) loadAndVerifyLocalLicense() (*SignedLicenseData, error) {
	fileBytes, err := os.ReadFile(path.Join(a.userResourcesPath, "license.json"))
	if err != nil {
		// This is not a critical error, just means no local license exists.
		return nil, fmt.Errorf("local license file not found: %w", err)
	}

	var license SignedLicenseData
	if err := json.Unmarshal(fileBytes, &license); err != nil {
		return nil, fmt.Errorf("failed to parse local license file: %w", err)
	}

	if err := a.verifySignature(license.Data, license.Signature); err != nil {
		return nil, fmt.Errorf("local license signature is invalid: %w", err)
	}

	return &license, nil
}

// saveLocalLicense saves the verified data to the local license file.
func (a *App) saveLocalLicense(license *SignedLicenseData) error {
	fileBytes, err := json.MarshalIndent(license, "", "  ")
	if err != nil {
		return fmt.Errorf("failed to serialize license for saving: %w", err)
	}
	licenseFile := path.Join(a.userResourcesPath, "license.json")
	return os.WriteFile(licenseFile, fileBytes, 0644)
}

func (a *App) HasAValidLicense() bool {
	if a.licenseValid {
		log.Printf("Returning saved value for license check. (%t)", a.licenseValid)
		return a.licenseValid
	}

	if a.licenseVerifyKey == nil {
		log.Println("License check failed: public key not configured.")
		return false
	}

	// 1. Try to load and verify the local license.
	localLicense, err := a.loadAndVerifyLocalLicense()
	if err != nil {
		log.Printf("No valid local license found: %v", err)
		return false // No local license means no access.
	}

	// 2. Check if the local license is fresh enough (e.g., < 24 hours old).
	if issuedAt, ok := localLicense.Data["issued_at"].(float64); ok {
		issueTime := time.Unix(int64(issuedAt), 0)
		if time.Since(issueTime) < 24*time.Hour {
			log.Println("Verified using fresh local license.")
			return true // License is fresh and valid.
		}
	}

	// 3. If stale, attempt an online re-validation.
	log.Println("Local license is stale, attempting online re-verification.")

	// Extract the license key from the local data to perform the check.
	var licenseKey string
	if gumroadResponse, ok := localLicense.Data["details"].(map[string]interface{}); ok {
		if purchase, ok := gumroadResponse["purchase"].(map[string]interface{}); ok {
			if key, ok := purchase["license_key"].(string); ok {
				licenseKey = key
			}
		}
	}

	if licenseKey == "" {
		log.Println("Could not extract license key from stale local file. Access denied.")
		return false // Can't re-verify without the key.
	}

	// Use the public verification function to re-validate.
	_, err = a.VerifyLicense(licenseKey)
	if err != nil {
		log.Printf("Online re-verification failed: %v. Granting access based on stale license (offline mode).", err)
		// The re-validation failed (e.g., offline), but since a valid (though stale)
		// license exists, we can grant access in a grace period.
		return true
	}

	log.Println("Online re-verification successful.")
	return true
}

// VerifyLicense is the main function exposed to the Wails frontend for initial activation.
// It requires an internet connection and returns the verified license data or an error.
func (a *App) VerifyLicense(licenseKey string) (map[string]interface{}, error) {
	if licenseKey == "" {
		return nil, errors.New("license key cannot be empty")
	}
	// 1. Perform online verification.
	verifyURL := "https://api.hushcut.app/verify_license"
	// if a.isDev {
	// 	verifyURL = "http://localhost:8080/verify_license"
	// }

	reqBody, err := json.Marshal(map[string]string{"license_key": licenseKey})
	if err != nil {
		return nil, fmt.Errorf("internal error creating request: %w", err)
	}

	resp, err := http.Post(verifyURL, "application/json", bytes.NewBuffer(reqBody))
	if err != nil {
		return nil, fmt.Errorf("cannot connect to verification server; please check your internet connection and try again")
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		// read the http error header
		body, _ := io.ReadAll(resp.Body)
		fmt.Println("Body:", string(body))
		returnMessage := string(body)
		if returnMessage == "" {
			returnMessage = fmt.Sprintf("license key is invalid or server returned an error (status: %s)", resp.Status)
		}
		return nil, fmt.Errorf("%s", returnMessage)
	}

	body, err := io.ReadAll(resp.Body)
	if err != nil {
		return nil, fmt.Errorf("failed to read server response: %w", err)
	}

	var newLicense SignedLicenseData
	if err := json.Unmarshal(body, &newLicense); err != nil {
		return nil, fmt.Errorf("failed to parse server response: %w", err)
	}

	// 2. CRITICAL: Verify the signature of the data received from the server.
	if err := a.verifySignature(newLicense.Data, newLicense.Signature); err != nil {
		return nil, fmt.Errorf("server response verification failed: %w. The response may have been tampered with", err)
	}

	// 3. Save the newly verified license data locally for future checks.
	if err := a.saveLocalLicense(&newLicense); err != nil {
		// This is not a fatal error for the current check, but we should log it.
		log.Printf("Warning: failed to save updated license file: %v", err)
	}

	log.Println("Successfully verified and saved license online.")
	a.signalLicenseOk() // Signal that the license is now valid.
	return newLicense.Data, nil
}
