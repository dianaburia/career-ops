package data

import (
	"fmt"
	"os"
	"path/filepath"
	"strings"

	"github.com/santifer/career-ops/dashboard/internal/model"
)

// jobsFilePath resolves the location of jobs.md — prefers {path}/data/jobs.md.
func jobsFilePath(careerOpsPath string) (string, []byte, error) {
	candidates := []string{
		filepath.Join(careerOpsPath, "data", "jobs.md"),
		filepath.Join(careerOpsPath, "jobs.md"),
	}
	for _, p := range candidates {
		if content, err := os.ReadFile(p); err == nil {
			return p, content, nil
		}
	}
	return "", nil, fmt.Errorf("jobs.md not found under %s", careerOpsPath)
}

// ParseJobs reads jobs.md and returns the parsed rows.
func ParseJobs(careerOpsPath string) []model.Job {
	_, content, err := jobsFilePath(careerOpsPath)
	if err != nil {
		return nil
	}

	jobs := make([]model.Job, 0)
	for _, line := range strings.Split(string(content), "\n") {
		trimmed := strings.TrimSpace(line)
		if trimmed == "" || !strings.HasPrefix(trimmed, "|") {
			continue
		}
		// Skip header separator rows and the header itself
		if strings.HasPrefix(trimmed, "|---") || strings.HasPrefix(trimmed, "|-") {
			continue
		}
		lower := strings.ToLower(trimmed)
		if strings.Contains(lower, "| status") && strings.Contains(lower, "| company") {
			continue
		}

		fields := splitPipeRow(trimmed)
		if len(fields) < 7 {
			continue
		}

		jobs = append(jobs, model.Job{
			Status:   fields[0],
			Date:     fields[1],
			Company:  fields[2],
			Role:     fields[3],
			Location: fields[4],
			URL:      fields[5],
			Notes:    fields[6],
			RawLine:  line,
		})
	}
	return jobs
}

// splitPipeRow splits a markdown table row into trimmed cell values.
func splitPipeRow(line string) []string {
	line = strings.TrimSpace(line)
	line = strings.TrimPrefix(line, "|")
	line = strings.TrimSuffix(line, "|")
	parts := strings.Split(line, "|")
	cells := make([]string, len(parts))
	for i, p := range parts {
		cells[i] = strings.TrimSpace(p)
	}
	return cells
}

// ComputeJobsMetrics counts rows by normalized status.
func ComputeJobsMetrics(jobs []model.Job) model.JobsMetrics {
	m := model.JobsMetrics{
		Total:    len(jobs),
		ByStatus: make(map[string]int),
	}
	for _, j := range jobs {
		m.ByStatus[NormalizeJobStatus(j.Status)]++
	}
	return m
}

// NormalizeJobStatus maps raw status text to a canonical key.
// Empty/blank status means "new" (unprocessed).
func NormalizeJobStatus(raw string) string {
	s := strings.TrimSpace(strings.ToLower(raw))
	if s == "" {
		return "new"
	}
	switch {
	case strings.Contains(s, "skip"):
		return "skip"
	case strings.Contains(s, "interview"):
		return "interview"
	case strings.Contains(s, "offer"):
		return "offer"
	case strings.Contains(s, "responded"):
		return "responded"
	case strings.Contains(s, "applied"):
		return "applied"
	case strings.Contains(s, "rejected"):
		return "rejected"
	case strings.Contains(s, "discarded"):
		return "discarded"
	case strings.Contains(s, "evaluated"):
		return "evaluated"
	default:
		return s
	}
}

// UpdateJobStatus rewrites the Status cell of the given job in jobs.md.
// Matching is done by the job's RawLine so user formatting elsewhere is preserved.
func UpdateJobStatus(careerOpsPath string, job model.Job, newStatus string) error {
	path, content, err := jobsFilePath(careerOpsPath)
	if err != nil {
		return err
	}

	lines := strings.Split(string(content), "\n")
	for i, line := range lines {
		if line != job.RawLine {
			continue
		}
		updated, ok := replaceStatusCell(line, newStatus)
		if !ok {
			return fmt.Errorf("could not locate status cell in row")
		}
		lines[i] = updated
		return os.WriteFile(path, []byte(strings.Join(lines, "\n")), 0644)
	}
	return fmt.Errorf("row not found in jobs.md")
}

// replaceStatusCell rewrites the first (Status) cell of a pipe-delimited row,
// preserving the leading/trailing whitespace of that cell so columns stay aligned.
func replaceStatusCell(line, newStatus string) (string, bool) {
	// Expect form: "| <status> | <date> | ..."
	if !strings.HasPrefix(strings.TrimSpace(line), "|") {
		return "", false
	}
	// Find first and second '|' to isolate the status cell
	first := strings.Index(line, "|")
	if first < 0 {
		return "", false
	}
	second := strings.Index(line[first+1:], "|")
	if second < 0 {
		return "", false
	}
	second += first + 1

	cell := line[first+1 : second]
	// Preserve leading/trailing whitespace inside the cell
	leading := cell[:len(cell)-len(strings.TrimLeft(cell, " \t"))]
	trailing := cell[len(strings.TrimRight(cell, " \t")):]
	if leading == "" {
		leading = " "
	}
	if trailing == "" {
		trailing = " "
	}

	return line[:first+1] + leading + newStatus + trailing + line[second:], true
}
