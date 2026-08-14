package repo

import (
	"app-task/internal/db"
	"app-task/internal/model"
)

// GetAnswersByTaskID reads the user's answers for the task detail endpoint
// (one row per question when question_count > 1, ordered by question_index).
// Answers are WRITTEN by the main app (POST /tasks/{id}/answer); app-task only
// reads the shared MySQL table task_quiz_answer.
func GetAnswersByTaskID(taskID string) ([]model.TaskQuizAnswer, error) {
	var ans []model.TaskQuizAnswer
	err := db.DB.Where("task_id = ?", taskID).Order("question_index").Find(&ans).Error
	if err != nil {
		return nil, err
	}
	return ans, nil
}
