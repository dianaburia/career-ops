package data

import (
	"fmt"
	"os"
	"path/filepath"
	"strings"

	"github.com/santifer/career-ops/dashboard/internal/model"
)

// jobsFilePath resolves the location of a jobs tracker file — prefers {path}/data/{fileName}.
func jobsFilePath(careerOpsPath, fileName string) (string, []byte, error) {
	if fileName == "" {
		fileName = "jobs.md"
	}
	candidates := []string{
		filepath.Join(careerOpsPath, "data", fileName),
		filepath.Join(careerOpsPath, fileName),
	}
	for _, p := range candidates {
		if content, err := os.ReadFile(p); err == nil {
			return p, content, nil
		}
	}
	return "", nil, fmt.Errorf("%s not found under %s", fileName, careerOpsPath)
}

// ParseJobs reads jobs.md and returns the parsed rows.
func ParseJobs(careerOpsPath string) []model.Job {
	return ParseJobsFile(careerOpsPath, "jobs.md")
}

// ParseJobsFile reads a jobs-style markdown tracker and returns the parsed rows.
func ParseJobsFile(careerOpsPath, fileName string) []model.Job {
	_, content, err := jobsFilePath(careerOpsPath, fileName)
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
		// New format: 8 cells (# | Status | Date | Company | Role | Location | URL | Notes)
		// Legacy format: 7 cells without leading #
		if len(fields) < 7 {
			continue
		}

		job := model.Job{RawLine: line}
		if len(fields) >= 8 {
			// New layout with leading # column
			job.Status = fields[1]
			job.Date = fields[2]
			job.Company = fields[3]
			job.Role = fields[4]
			job.Location = fields[5]
			job.URL = fields[6]
			job.Notes = fields[7]
		} else {
			// Legacy 7-column layout
			job.Status = fields[0]
			job.Date = fields[1]
			job.Company = fields[2]
			job.Role = fields[3]
			job.Location = fields[4]
			job.URL = fields[5]
			job.Notes = fields[6]
		}
		jobs = append(jobs, job)
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
	return UpdateJobStatusFile(careerOpsPath, "jobs.md", job, newStatus)
}

// UpdateJobStatusFile rewrites the Status cell in a jobs-style markdown tracker.
func UpdateJobStatusFile(careerOpsPath, fileName string, job model.Job, newStatus string) error {
	path, content, err := jobsFilePath(careerOpsPath, fileName)
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
	return fmt.Errorf("row not found in %s", fileName)
}

// replaceStatusCell rewrites the Status cell of a pipe-delimited row.
// New layout has # as the first cell, so Status is the second. Legacy layout
// (no leading # column, 7 cells) has Status as the first.
func replaceStatusCell(line, newStatus string) (string, bool) {
	if !strings.HasPrefix(strings.TrimSpace(line), "|") {
		return "", false
	}
	cellCount := strings.Count(line, "|") - 1
	// New layout: 8 cells between 9 pipes → Status is cell index 1 (second).
	// Legacy layout: 7 cells → Status is cell index 0 (first).
	statusCellIdx := 0
	if cellCount >= 8 {
		statusCellIdx = 1
	}

	// Locate the pipe pair surrounding the target cell.
	startPipe := -1
	cellsSeen := -1
	for i, r := range line {
		if r == '|' {
			cellsSeen++
			if cellsSeen == statusCellIdx {
				startPipe = i
				break
			}
		}
	}
	if startPipe < 0 {
		return "", false
	}
	endPipe := strings.Index(line[startPipe+1:], "|")
	if endPipe < 0 {
		return "", false
	}
	endPipe += startPipe + 1

	cell := line[startPipe+1 : endPipe]
	leading := cell[:len(cell)-len(strings.TrimLeft(cell, " \t"))]
	trailing := cell[len(strings.TrimRight(cell, " \t")):]
	if leading == "" {
		leading = " "
	}
	if trailing == "" {
		trailing = " "
	}
	return line[:startPipe+1] + leading + newStatus + trailing + line[endPipe:], true
}
