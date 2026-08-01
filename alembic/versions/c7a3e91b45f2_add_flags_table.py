"""add flags table

A flag is a moment in a lecture the student didn't follow, raised by selecting a
span of the live transcript. ON DELETE CASCADE matters here: repository's
7-lecture cap evicts old Sessions, and their flags must go with them.

Revision ID: c7a3e91b45f2
Revises: de5514451592
Create Date: 2026-07-29 14:10:00.000000

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision: str = 'c7a3e91b45f2'
down_revision: Union[str, Sequence[str], None] = 'de5514451592'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    """Upgrade schema."""
    op.create_table(
        'flags',
        sa.Column('id', sa.Integer(), nullable=False),
        sa.Column('session_id', sa.Integer(), nullable=False),
        # Seconds from the start of the recording. Absolute — transcribe_chunk
        # already folds chunk_offset into every word's start/end.
        sa.Column('t_start', sa.Float(), nullable=False),
        sa.Column('t_end', sa.Float(), nullable=False),
        sa.Column('quote', sa.Text(), nullable=False),
        # Nullable: flagging a moment is one tap and needn't carry a question.
        sa.Column('question', sa.Text(), nullable=True),
        sa.Column('answer', sa.Text(), nullable=True),
        sa.Column('resolved', sa.Boolean(), server_default='0', nullable=False),
        sa.Column('created_at', sa.DateTime(), server_default=sa.func.now(), nullable=False),
        sa.ForeignKeyConstraint(
            ['session_id'], ['sessions.id'],
            name='fk_flags_session_id_sessions', ondelete='CASCADE',
        ),
        sa.PrimaryKeyConstraint('id', name='pk_flags'),
    )
    op.create_index('ix_flags_session_id', 'flags', ['session_id'], unique=False)


def downgrade() -> None:
    """Downgrade schema."""
    op.drop_index('ix_flags_session_id', table_name='flags')
    op.drop_table('flags')
