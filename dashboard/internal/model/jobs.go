package model

// Job represents a row in data/jobs.md (simple tracker, no reports/scoring).
type Job struct {
	Status   string
	Date     string
	Company  string
	Role     string
	Location string
	URL      string
	Notes    string
	// RawLine is the original line from jobs.md — used to locate the row on update.
	RawLine string
}

// JobsMetrics holds aggregate counts for the jobs screen.
type JobsMetrics struct {
	Total    int
	ByStatus map[string]int
}
