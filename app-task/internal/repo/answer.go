package repo

import (
	"app-task/internal/db"
	"app-task/internal/model"

	"gorm.io/gorm"
)

func CreateAnswer(a *model.TaskQuizAnswer) error {
	return db.DB.Create(a).Error
}

func GetAnswerByTaskID(taskID string) (*model.TaskQuizAnswer, error) {
	var a model.TaskQuizAnswer
	err := db.DB.Where("task_id = ?", taskID).First(&a).Error
	if err == gorm.ErrRecordNotFound {
		return nil, nil
	}
	return &a, err
}
