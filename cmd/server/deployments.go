package main

import (
	_ "embed"
	"encoding/json"
	"fmt"
	"slices"
)

// Generated from the pinned catalog by scripts/sync-deployments.py. The same
// support list drives API validation, browser selectors, and exported labels.
//
//go:embed deployments.json
var deploymentData []byte

type ModelOption struct {
	ID                  string   `json:"id"`
	Label               string   `json:"label"`
	NativeContextTokens int      `json:"nativeContextTokens"`
	HardwareIDs         []string `json:"hardwareIds"`
}

type HardwareOption struct {
	ID         string  `json:"id"`
	Label      string  `json:"label"`
	ShortLabel string  `json:"shortLabel"`
	MemoryGiB  float64 `json:"memoryGiB"`
}

type DeploymentOptions struct {
	CatalogCommit   string           `json:"catalogCommit"`
	Precision       string           `json:"precision"`
	ContextLimit    int              `json:"contextLimit"`
	GPUsPerInstance int              `json:"gpusPerInstance"`
	Models          []ModelOption    `json:"models"`
	Hardware        []HardwareOption `json:"hardware"`
}

type Deployment struct {
	Model           ModelOption    `json:"model"`
	Hardware        HardwareOption `json:"hardware"`
	Precision       string         `json:"precision"`
	ContextLimit    int            `json:"contextLimit"`
	GPUsPerInstance int            `json:"gpusPerInstance"`
}

var deploymentOptions = func() DeploymentOptions {
	var options DeploymentOptions
	if err := json.Unmarshal(deploymentData, &options); err != nil {
		panic(err)
	}
	return options
}()

func resolveDeployment(modelID, hardwareID string) (Deployment, error) {
	modelIndex := slices.IndexFunc(deploymentOptions.Models, func(m ModelOption) bool { return m.ID == modelID })
	if modelIndex < 0 {
		return Deployment{}, fmt.Errorf("Choose a supported model from the model selector.")
	}
	hardwareIndex := slices.IndexFunc(deploymentOptions.Hardware, func(h HardwareOption) bool { return h.ID == hardwareID })
	if hardwareIndex < 0 {
		return Deployment{}, fmt.Errorf("Choose a supported GPU from the GPU selector.")
	}
	model := deploymentOptions.Models[modelIndex]
	hardware := deploymentOptions.Hardware[hardwareIndex]
	if !slices.Contains(model.HardwareIDs, hardwareID) {
		return Deployment{}, fmt.Errorf("%s on %s is not supported by this simulator.", model.Label, hardware.Label)
	}
	return Deployment{model, hardware, deploymentOptions.Precision, deploymentOptions.ContextLimit, deploymentOptions.GPUsPerInstance}, nil
}
