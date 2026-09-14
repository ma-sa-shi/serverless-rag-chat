from app.repositories.users import BATCH_GET_MAX_KEYS, UserRepository
from tests.conftest import TABLE_NAME


def test_get_display_names_skips_users_without_profile(aws):
    repository = UserRepository(TABLE_NAME)
    repository.upsert_profile("user-a", "山田 太郎", "taro@example.com")

    names = repository.get_display_names({"user-a", "user-without-profile"})

    assert names == {"user-a": "山田 太郎"}


def test_get_display_names_splits_requests_over_batch_limit(aws):
    repository = UserRepository(TABLE_NAME)
    user_ids = {f"user-{i}" for i in range(BATCH_GET_MAX_KEYS + 1)}
    for user_id in user_ids:
        repository.upsert_profile(user_id, f"name-{user_id}", "user@example.com")

    names = repository.get_display_names(user_ids)

    assert names == {user_id: f"name-{user_id}" for user_id in user_ids}


def test_get_display_names_with_no_users_returns_empty(aws):
    assert UserRepository(TABLE_NAME).get_display_names(set()) == {}
